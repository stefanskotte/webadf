import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { readWifiRow } from '@/lib/wifi-networks-store';
import { deliverWifi } from '@/lib/wifi-networks';

// The instruction behind the poll's wifi.v (src/lib/wifi-networks.ts; the board's side is wifi_ctl.h):
//   {"seq":N,"op":"open"|"close"|"remove"|"none","ssid":"<hex>"}
// ssid only with remove. A plain read: the board may ask again; it acks the seq on its next poll and report.

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
  const row = await readWifiRow(device.deviceId);
  // Deleted between auth and read: 404, never a body the board could act on.
  if (!row) return Response.json({ error: 'device_not_found' }, { status: 404, headers: NO_STORE });
  return Response.json(deliverWifi(row, Date.now()), { headers: NO_STORE });
}
