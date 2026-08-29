import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { readDesired, readDesiredVersion } from '@/lib/mount';

// Holds up to 25 s. maxDuration covers the hold plus slack; the platform
// default would cut the connection mid-hold.
export const maxDuration = 60;

const HOLD_MS = 25_000;
const TICK_MS = 1_000;

export async function GET(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }

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
    if (version === null) return Response.json({ error: 'device_not_found' }, { status: 404 });

    if (version > from) {
      const state = await readDesired(device.deviceId);
      if (!state) return Response.json({ error: 'device_not_found' }, { status: 404 });
      return Response.json({ version: state.version, desired: state.desired });
    }
    if (Date.now() >= deadline) return new Response(null, { status: 204 });
    // Works where the platform wires request cancellation into `signal`,
    // including local dev. On this repo's Vercel deployment it is currently
    // inert: cancellation only reaches `request.signal` for a route that
    // opts in via deployment config, which this route does not do. Left in
    // rather than removed -- it costs nothing and starts working the day
    // that opt-in is added -- but do not read it as protection that exists
    // today.
    if (request.signal.aborted) return new Response(null, { status: 499 });
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
