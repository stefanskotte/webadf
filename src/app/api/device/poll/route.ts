import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import {
  readDesired, readDesiredVersion, readFirmwareCursor, readFirmwareInstruction,
  touchLastSeen,
} from '@/lib/mount';

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

  const deadline = Date.now() + HOLD_MS;
  for (;;) {
    // Cheap single-column read per tick. The three-table join runs only when
    // the version has actually moved — 25 joins per hold would be waste.
    const version = await readDesiredVersion(device.deviceId);

    // The device authenticated against this row, so it existed a moment ago.
    // If it has been deleted mid-poll that is a 404 — NEVER a 200 the device
    // could read as an eject instruction. Spec §1 rule 1.
    if (version === null) return notFound();

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
    // Two integers off the devices row the tick already touches -- NOT the
    // release join, which belongs on the delivery path below. The comment
    // above about 25 joins per hold applies to this read too.
    const firmwareMoved = await readFirmwareCursor(device.deviceId);

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
    if (version > clampedFrom || clampedFrom !== from || firmwareMoved) {
      const state = await readDesired(device.deviceId);
      if (!state) return notFound();
      // Resolved only here, and only when the device has not acknowledged it.
      // Sending it again to a board that already answered is what re-issued
      // an instruction to a board mid-flash and re-tried an update that had
      // already failed -- both of which the spec forbids.
      const update = firmwareMoved ? await readFirmwareInstruction(device.deviceId) : null;
      return Response.json(
        // `update` last. NOTE: this is for readability, not safety -- the
        // firmware refuses a truncated body OUTRIGHT (device_client.c's
        // body.truncated check), so nothing is "lost last". What keeps the
        // body inside DC_POLL_BODY_BYTES is readDesired bounding its own
        // free-text fields; see the note there.
        {
          version: state.version,
          desired: state.desired,
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
