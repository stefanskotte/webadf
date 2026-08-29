import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { hashDeviceToken, tokensMatch } from '@/lib/device-token';

export class DeviceAuthError extends Error {
  constructor() { super('device authentication failed'); }
}

export async function requireDevice(request: Request): Promise<{ deviceId: string; orgId: string }> {
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new DeviceAuthError();

  const hash = hashDeviceToken(m[1]);
  const rows = await getDb()
    .select({ id: devices.id, orgId: devices.orgId, tokenHash: devices.tokenHash })
    .from(devices)
    .where(eq(devices.tokenHash, hash))
    .limit(1);

  const row = rows[0];
  // The lookup is already by hash; the constant-time compare guards against a
  // future change that widens the query.
  if (!row || !tokensMatch(row.tokenHash, hash)) throw new DeviceAuthError();
  return { deviceId: row.id, orgId: row.orgId };
}
