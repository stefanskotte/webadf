import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { buildXfer } from '@/lib/xfer-wire';
import {
  readDesired, readPollTick, readFirmwareInstruction, touchLastSeen, markNetNextSent,
} from '@/lib/mount';
import { readNfcWriteRow } from '@/lib/nfc/store';
import { nfcWriteForPoll } from '@/lib/nfc/rules';
import { readNextForPoll } from '@/lib/next-disk';
import { readDf1ForPoll } from '@/lib/df1-store';
import { DC_TITLE_MAX } from '@/lib/device-limits';
import { getDb } from '@/db';
import { recordSendRx } from '@/lib/transfers';
import { PAULANET_NEXT, driverDiskFor, netApplied, netKeepsDriverDisk } from '@/lib/paulanet-disk';
import { parseBoot } from '@/lib/boot-disk';

// Holds up to 25 s. maxDuration covers the hold plus slack; the platform
// default would cut the connection mid-hold.
export const maxDuration = 60;

const HOLD_MS = 25_000;
const TICK_MS = 1_000;

const NO_STORE = { 'cache-control': 'no-store' };

function notFound() {
  return Response.json({ error: 'device_not_found' }, { status: 404, headers: NO_STORE });
}

export async function GET(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) {
      // A cached 401 served against the wrong bearer would be both a
      // cross-tenant leak and, on a device-facing route, indistinguishable
      // from a spurious instruction -- no response here may be cached.
      res.headers.set('cache-control', 'no-store');
      return res;
    }
    throw e;
  }

  // The poll is the one contact every device is guaranteed to make roughly
  // every 25 s (the hold) plus reconnect time, whether or not its status
  // POSTs are succeeding. Write last_seen_at here, once per request, so a
  // device with a broken status path still reads as recently seen rather
  // than pointing the operator at the hardware. src/lib/mount.ts's
  // touchLastSeen keeps this a single-column write, not the full recordStatus
  // path, which is for actual observations.
  //
  // Disk at startup (boot-disk.ts): the boot the board names rides the same write, before the first tick below, so
  // on "No disk" the first poll of a power-up already finds DF0 emptied and answers with no disk.
  await touchLastSeen(device.deviceId, parseBoot(new URL(request.url).searchParams));

  const sinceRaw = new URL(request.url).searchParams.get('since') ?? '0';
  // parseInt('1abc') is 1 -- a numeric-prefixed garbage value would parse to a
  // real, positive version and be read as "up to date," stranding the device
  // on stale state with no failure signal. Demand the whole string be digits
  // before trusting it at all, and fall back to "never polled" (0) for
  // anything else, including a value too large to represent exactly.
  const from = /^\d+$/.test(sinceRaw) && Number.isSafeInteger(Number(sinceRaw))
    ? Number(sinceRaw)
    : 0;

  // nfcAck is the board's own cursor for the write request (spec §5.3).
  // A MISSING parameter means the board does not speak NFC at all (firmware
  // before 1.3.0 sends ?since= alone): read as 0, any nfc_write_seq > 0 would
  // wake every poll at once, forever, on a board that can never acknowledge.
  // So absent -> null -> nfcMoved is always false and no nfcWrite key.
  // A PRESENT value is parsed exactly like `since` above and for the same
  // reason: a garbled value falls back to "never acknowledged" (0), never
  // "caught up", which would strand the board on a request it has not seen.
  const nfcAckRaw = new URL(request.url).searchParams.get('nfcAck');
  const nfcAck = nfcAckRaw === null
    ? null
    : /^\d+$/.test(nfcAckRaw) && Number.isSafeInteger(Number(nfcAckRaw))
      ? Number(nfcAckRaw)
      : 0;

  // displayAck is the board's display-layout cursor (OLED layouts, 1.7.0):
  // the highest display version it has HANDLED -- applied OR rejected.
  // Parsed exactly like nfcAck and for the same reasons: ABSENT means a board
  // before 1.7.0 that can never acknowledge, so it is never woken for display
  // (null); a garbled value falls back to 0, never to "caught up".
  //
  // The wake fires on ANY mismatch (display_version !== displayAck), not only
  // on display_version > displayAck. An ack ABOVE the version is real: a board
  // that re-paired across a reboot seeds its ack from the OLD row's stored
  // record (say 5) while the new row is at 0..4. With `>` that board was never
  // woken, never saw a body, so its `dv < ack` reset never ran -- the glass
  // kept the old row's custom layout and the editor said "Waiting" forever.
  //
  // It cannot loop. On a mismatch the board either fetches (dv > ack) and
  // acks dv, or resets its ack to dv (dv < ack); either way its next poll
  // sends displayAck === display_version and the hold holds. A layout the
  // board REJECTS is the same: the board still advances its ack to that
  // version (and reports the reason as displayError). The wake is
  // edge-triggered on the cursor, never on "the board has not applied it".
  const displayAckRaw = new URL(request.url).searchParams.get('displayAck');
  const displayAck = displayAckRaw === null
    ? null
    : /^\d+$/.test(displayAckRaw) && Number.isSafeInteger(Number(displayAckRaw))
      ? Number(displayAckRaw)
      : 0;

  // driveAck is the DF1 setting cursor (fw 1.9.0). Parsed like displayAck, for the same reasons.
  const driveAckRaw = new URL(request.url).searchParams.get('driveAck');
  const driveAck = driveAckRaw === null
    ? null
    : /^\d+$/.test(driveAckRaw) && Number.isSafeInteger(Number(driveAckRaw))
      ? Number(driveAckRaw)
      : 0;

  // df1Ack is the cursor of the disk mounted into DF1 (fw 1.12.0, spec 2026-10-14 §4.2). Parsed like driveAck, for
  // the same reasons: ABSENT means a board that cannot hold a pick -- never woken for one, never sent `df1`.
  const df1AckRaw = new URL(request.url).searchParams.get('df1Ack');
  const df1Ack = df1AckRaw === null
    ? null
    : /^\d+$/.test(df1AckRaw) && Number.isSafeInteger(Number(df1AckRaw))
      ? Number(df1AckRaw)
      : 0;

  // netPick=1 (fw 1.12.1): the board takes Network mode's driver disk as DF1's pick (`df1`), so `next` can be DF0's
  // next disk of the set in Network mode too. Only with df1Ack: a board that cannot hold a pick cannot hold this one.
  const netPick = df1Ack !== null && new URL(request.url).searchParams.get('netPick') === '1';

  // xferAck (fw 1.14.0, PaulaNET Phase 4): the send queue's cursor the board last fetched. ABSENT means a board that
  // cannot send files to its Amiga -- never woken for the queue, never sent `xfer`. rx is its receiver state.
  const xferAckRaw = new URL(request.url).searchParams.get('xferAck');
  const xferAck = xferAckRaw === null
    ? null
    : /^\d+$/.test(xferAckRaw) && Number.isSafeInteger(Number(xferAckRaw))
      ? Number(xferAckRaw)
      : 0;
  const rx = new URL(request.url).searchParams.get('rx');
  if (xferAck !== null && rx !== null && /^[cru-]$/.test(rx)) {
    await recordSendRx(getDb(), device.deviceId, rx as 'c' | 'r' | 'u' | '-');
  }

  const deadline = Date.now() + HOLD_MS;
  for (;;) {
    // Cheap single-column read per tick. The three-table join runs only when
    // the version has actually moved — 25 joins per hold would be waste.
    const tick = await readPollTick(device.deviceId);

    // The device authenticated against this row, so it existed a moment ago.
    // If it has been deleted mid-poll that is a 404 — NEVER a 200 the device
    // could read as an eject instruction. Spec §1 rule 1.
    if (tick === null) return notFound();
    const { version } = tick;

    // `since` can end up ahead of the version we are about to compare it to
    // -- reachable after a database restore rolls desired_version backward.
    // Left unclamped, `version > from` is false forever: no future version
    // can ever exceed a `since` that is already bigger than anything the
    // server has ever produced, so the device 204s on every poll with no
    // signal, exactly the class of bug the garbled-string guard above
    // already exists to prevent. Math.min pins `from` to no more than the
    // real version before comparing; when that clamp actually changes the
    // value (`clampedFrom !== from`), `since` was already invalid, and that
    // alone must be enough to deliver the current state immediately rather
    // than waiting for a version that can never arrive.
    // Off the SAME row read above -- no second query, no join. The comment
    // about 25 joins per hold applies to this just as much.
    const firmwareMoved = tick.instructionVersion > tick.instructionAck;
    // Same cursor comparison as firmwareMoved, off the same row read. A
    // cancelled or expired request is still DELIVERED below (as a disarm,
    // diskId null) rather than silently dropped, so nfcAck catches up to
    // nfcWriteSeq on the very poll that wakes for it -- without that, the
    // hold would release every second forever on a request the board can
    // never acknowledge.
    const nfcMoved = nfcAck !== null && tick.nfcWriteSeq > nfcAck;
    // Cursor comparison off the same row read, but on INEQUALITY (see the
    // displayAck comment above: an ack above the version must wake too, so
    // the board can reset). The board fetches the layout itself
    // (GET /api/device/display) when it sees displayVersion ahead of its ack;
    // the poll body only announces the number.
    const displayMoved = displayAck !== null && tick.displayVersion !== displayAck;

    const driveMoved = driveAck !== null && tick.secondDriveVersion !== driveAck;
    // INEQUALITY, the displayAck rule: a re-paired board carrying a higher ack is woken so it resets.
    const df1Moved = df1Ack !== null && tick.df1Version !== df1Ack;
    // INEQUALITY again: a re-paired board's higher ack is reset by the body that carries xfer.v.
    const xferMoved = xferAck !== null && tick.sendVersion !== xferAck;

    // Network mode (spec 2026-10-12 §2, pre-flight I2): the driver disk goes out as `next` only once the
    // board has REPORTED running Network for the current setting -- never on the choice alone, which would
    // have the board preload it under its old mode, into DF0's idle slot, and block the digest. The body
    // that delivers the setting therefore cannot carry it, and by the board's next poll its ack matches
    // and nothing else moves: without a wake of its own the driver disk would wait for an unrelated one
    // (a mount, a re-pair). So one wake, keyed on a CURSOR (net_next_sent_version, written below when a
    // body carries it), never on "the board does not hold it yet": a board that cannot load it (no slot,
    // a held-off digest) would otherwise be woken on every poll. Only a board that speaks driveAck.
    const netNow = driveAck !== null && netApplied(tick);
    const netNextMoved = netNow && tick.netNextSentVersion !== tick.secondDriveVersion;

    const clampedFrom = Math.min(from, version);
    // A firmware instruction the device has not acknowledged releases the
    // hold. It is a CURSOR comparison, like every other wake on this route --
    // so delivery is self-recording, a cancelled instruction is itself a wake,
    // and a board that has answered cannot re-trigger one.
    //
    // desiredVersion is deliberately NOT bumped to announce firmware: the
    // device echoes it back as mountedVersion and the server reads that for an
    // upload's not_mounted/behind verdict (HANDOFF 4g), so bumping it could
    // strand an Amiga write that was mid-session. See spec 4.2.
    if (version > clampedFrom || clampedFrom !== from || firmwareMoved || nfcMoved || displayMoved || driveMoved || netNextMoved || df1Moved || xferMoved) {
      const state = await readDesired(device.deviceId);
      if (!state) return notFound();
      // Multi-disk spec §3.3 / plan R1: the disk the board should preload.
      // Computed on delivery only (never per tick), and only with a disk desired.
      // Network mode, once applied (above): DF1 holds the PaulaNET driver disk instead of the next disk of
      // the set -- on every body, with or without a disk desired: the board keeps it in a slot of its own,
      // whatever DF0 holds (plan 2026-10-12 ruling 6). Until applied, and in Next disk / Off: as before --
      // except that a board already reporting Network keeps the driver disk across a re-save of 'net' that
      // bumped the version (final review m1): it is in Network either way, and any other `next` ejects it.
      //
      // A netPick board (fw 1.12.1) takes the driver disk as DF1's pick instead (below), and `next` is DF0's next
      // disk of the set in every mode. The one-shot wake then also moves the DF1 cursor, BEFORE df1 is read, so the
      // body that first names the driver disk carries a cursor the board has not acked.
      const netNext = netNow || (driveAck !== null && netKeepsDriverDisk(tick));
      // Which driver disk (R16): an older one stays while the Amiga's driver talks, never swapped under it.
      const driverSha = driverDiskFor(tick, Date.now());
      const next = netNext && !netPick ? { ...PAULANET_NEXT, sha256: driverSha }
        : state.desired ? await readNextForPoll(device.deviceId, device.orgId)
        : undefined;
      if (netNow && tick.netNextSentVersion !== tick.secondDriveVersion) {
        if (netPick) await markNetNextSent(device.deviceId, tick.secondDriveVersion, { bumpDf1: true });
        else await markNetNextSent(device.deviceId, tick.secondDriveVersion);
      }
      // Resolved only here, and only when the device has not acknowledged it.
      // Sending it again to a board that already answered is what re-issued
      // an instruction to a board mid-flash and re-tried an update that had
      // already failed -- both of which the spec forbids.
      // On every body to a board that sent df1Ack, not only one woken by the pick: the board takes `df1` from
      // whatever 200 reaches it, so a re-paired board's higher ack resets at its first one.
      // In Network mode a netPick board's pick is the driver disk (no disk row: the server's own image).
      const df1Read = df1Ack !== null ? await readDf1ForPoll(device.deviceId) : null;
      const df1 = df1Read && netPick && netNext ? { v: df1Read.v, sha256: driverSha } : df1Read;
      const update = firmwareMoved ? await readFirmwareInstruction(device.deviceId) : null;
      // Same pattern as `update`: resolved only when the cursor says the
      // board has not caught up, never on every tick. nfcWriteForPoll turns
      // a cancelled/expired/already-answered request into the disarm
      // (diskId null) that lets nfcAck catch up -- see the comment on
      // nfcMoved above.
      const nfcRow = nfcMoved ? await readNfcWriteRow(device.deviceId) : null;
      const nfc = nfcRow && nfcAck !== null ? nfcWriteForPoll(nfcRow, nfcAck, new Date()) : null;
      return Response.json(
        // `instructionVersion` is ALWAYS present, `update` only when there is
        // one. That asymmetry is the point: a cancellation moves the cursor
        // and delivers no instruction, so without a cursor to echo the board
        // could never acknowledge it -- `want > ack` would stay true and the
        // 25 s hold would collapse into an immediate-return loop, forever.
        // The board echoes this as firmwareInstructionAck whether or not an
        // update came with it. nfcWrite works the same way off nfcAck: the
        // key is present only when nfcWriteForPoll has something to say
        // (including a disarm), never merely because nfcMoved was true.
        //
        // nfcWrite.title is bounded to DC_TITLE_MAX HERE, the same way
        // readDesired bounds `game` -- games.title is an unlimited `text`
        // column (readNfcWriteRow reads it raw), and DC_POLL_BODY_BYTES is a
        // fixed buffer the firmware refuses to parse AT ALL when the body
        // doesn't fit whole (device-limits.ts). Left unbounded, one long
        // TOSEC title would make nfcWrite alone push the body over budget --
        // the board could then never parse the poll, never advance nfcAck,
        // and the hold would wake immediately for the whole 2 min request
        // lifetime with mounting/ejecting dead for that long. Bounding right
        // here, not in readNfcWriteRow, keeps it visible at the one place
        // the body is actually assembled -- see device-limits.test.ts for
        // the worst-case byte count this bound is sized against.
        //
        // `update` last. NOTE: that ordering is for readability, not safety --
        // the firmware refuses a truncated body OUTRIGHT (device_client.c's
        // body.truncated check), so nothing is "lost last". What keeps the
        // body inside DC_POLL_BODY_BYTES is readDesired bounding its own
        // free-text fields; see the note there.
        {
          version: state.version,
          desired: state.desired,
          // Absent with desired: null -- except in Network mode, once applied, for a board without netPick (the
          // driver disk; a netPick board gets it in `df1`).
          ...(next !== undefined ? { next } : {}),
          instructionVersion: tick.instructionVersion,
          // On EVERY body answering a poll that sent displayAck, not only one
          // woken by the display: the board reads a displayVersion BELOW its
          // ack as a server-side reset (a re-paired board carrying the old
          // row's ack) and starts over at 0 -- which it can only do if the
          // number reaches it on whatever wakes it next. Absent for a board
          // that sent no displayAck (before 1.7.0).
          ...(displayAck !== null ? { displayVersion: tick.displayVersion } : {}),
          // Inline: one byte of setting needs no fetch (spec §3). Every body for a board
          // that sent driveAck, so a re-paired board's higher ack is reset at its first 200.
          ...(driveAck !== null ? { secondDrive: { seq: tick.secondDriveVersion, mode: tick.secondDrive } } : {}),
          // DF1 any disk (spec 2026-10-14 §4.2): {v, sha256}, sha256 null without a pick (DF1 follows the set).
          ...(df1 !== null ? { df1 } : {}),
          // The send queue's cursor (PaulaNET Phase 4): the board fetches GET /api/device/send/queue when it moves.
          // Plus the Amiga's last address (R17): 1.16.0 seeds its sorter with it after a reboot. Older senders ignore
          // `ip`; the object stays under their 48-byte buffer (buildXfer, measured in device-limits.test.ts).
          ...(xferAck !== null ? { xfer: buildXfer(tick.sendVersion, tick.netAmigaIpLast) } : {}),
          ...(nfc
            ? {
                nfcWrite: {
                  seq: nfc.seq,
                  diskId: nfc.diskId,
                  title: nfc.diskId
                    ? (nfcRow!.title !== null ? nfcRow!.title.slice(0, DC_TITLE_MAX) : null)
                    : null,
                  ...(nfc.kind === 'next' ? { kind: 'next' } : {}),
                },
              }
            : {}),
          ...(update ? { update } : {}),
        },
        { headers: NO_STORE },
      );
    }
    if (Date.now() >= deadline) return new Response(null, { status: 204, headers: NO_STORE });
    // Works where the platform wires request cancellation into `signal`,
    // including local dev. On this repo's Vercel deployment it is currently
    // inert: cancellation only reaches `request.signal` for a route that
    // opts in via deployment config, which this route does not do. Left in
    // rather than removed -- it costs nothing and starts working the day
    // that opt-in is added -- but do not read it as protection that exists
    // today.
    if (request.signal.aborted) return new Response(null, { status: 499, headers: NO_STORE });
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
