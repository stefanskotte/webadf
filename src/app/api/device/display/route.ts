import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { readDisplay } from '@/lib/display-store';

// The board's display layout, binary (plan Global Constraints; no base64 or
// JSON on the board):
//
//   [u32 big-endian version][u8 panel: 0 = 128x32, 1 = 128x64][u8 has_layout][blob if has_layout]
//
// The board fetches this when the poll's displayVersion is ahead of its
// displayAck, validates the blob with the same C validator the PATCH route
// ran, and acks `version` whether it applied it or rejected it.

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) {
      // No response on a device-facing route may be cached (see the poll route).
      res.headers.set('cache-control', 'no-store');
      return res;
    }
    throw e;
  }

  const row = await readDisplay(device.deviceId);
  // Deleted between auth and read: 404, never a body the board could act on.
  if (!row) return Response.json({ error: 'device_not_found' }, { status: 404, headers: NO_STORE });

  const layout = row.layout && row.layout.length > 0 ? row.layout : null;
  const out = new Uint8Array(6 + (layout?.length ?? 0));
  new DataView(out.buffer).setUint32(0, row.version, false);
  out[4] = row.panel === '128x64' ? 1 : 0;
  out[5] = layout ? 1 : 0;
  if (layout) out.set(layout, 6);

  return new Response(out, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(out.length),
      ...NO_STORE,
    },
  });
}
