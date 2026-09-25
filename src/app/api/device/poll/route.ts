import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import {
  readDesired, readPollTick, readFirmwareInstruction, touchLastSeen,
} from '@/lib/mount';
import { readNfcWriteRow } from '@/lib/nfc/store';
import { nfcWriteForPoll } from '@/lib/nfc/rules';

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
  await touchLastSeen(device.deviceId);

  const sinceRaw = new URL(request.url).searchParams.get('since') ?? '0';
  // parseInt('1abc') is 1 -- a numeric-prefixed garbage value would parse to a
  // real, positive version and be read as "up to date," stranding the device
  // on stale state with no failure signal. Demand the whole string be digits
  // before trusting it at all, and fall back to "never polled" (0) for
  // anything else, including a value too large to represent exactly.
  const from = /^\d+$/.test(sinceRaw) && Number.isSafeInteger(Number(sinceRaw))
    ? Number(sinceRaw)
    : 0;

  // nfcAck is the board's own cursor for the write request (spec §5.3),
  // parsed exactly like `since` above and for the same reason: a garbled
  // value must fall back to "never acknowledged" (0), never be read as
  // "caught up" and strand the board on a request it has not actually seen.
  const nfcAckRaw = new URL(request.url).searchParams.get('nfcAck') ?? '0';
  const nfcAck = /^\d+$/.test(nfcAckRaw) && Number.isSafeInteger(Number(nfcAckRaw))
    ? Number(nfcAckRaw)
    : 0;

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
    const nfcMoved = tick.nfcWriteSeq > nfcAck;

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
    if (version > clampedFrom || clampedFrom !== from || firmwareMoved || nfcMoved) {
      const state = await readDesired(device.deviceId);
      if (!state) return notFound();
      // Resolved only here, and only when the device has not acknowledged it.
      // Sending it again to a board that already answered is what re-issued
      // an instruction to a board mid-flash and re-tried an update that had
      // already failed -- both of which the spec forbids.
      const update = firmwareMoved ? await readFirmwareInstruction(device.deviceId) : null;
      // Same pattern as `update`: resolved only when the cursor says the
      // board has not caught up, never on every tick. nfcWriteForPoll turns
      // a cancelled/expired/already-answered request into the disarm
      // (diskId null) that lets nfcAck catch up -- see the comment on
      // nfcMoved above.
      const nfcRow = nfcMoved ? await readNfcWriteRow(device.deviceId) : null;
      const nfc = nfcRow ? nfcWriteForPoll(nfcRow, nfcAck, new Date()) : null;
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
        // `update` last. NOTE: that ordering is for readability, not safety --
        // the firmware refuses a truncated body OUTRIGHT (device_client.c's
        // body.truncated check), so nothing is "lost last". What keeps the
        // body inside DC_POLL_BODY_BYTES is readDesired bounding its own
        // free-text fields; see the note there.
        {
          version: state.version,
          desired: state.desired,
          instructionVersion: tick.instructionVersion,
          ...(nfc
            ? { nfcWrite: { seq: nfc.seq, diskId: nfc.diskId, title: nfc.diskId ? nfcRow!.title : null } }
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
