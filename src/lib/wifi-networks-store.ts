import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import type { WifiAction, WifiRow } from '@/lib/wifi-networks';

export type RequestWifiOutcome =
  | { seq: number }
  | 'not_found' | 'firmware_too_old' | 'not_saved' | 'in_use' | 'only_one' | 'nothing_to_cancel';

/**
 * One org-scoped conditional UPDATE (the saveSecondDrive pattern): the capability and, for a remove, the list rules
 * live in the WHERE, so a report landing between a read and the write cannot slip a refused request through. The
 * board checks again (it is the one that knows a disk is in its drive), and says what it did in its next report.
 *
 * Every request moves the cursor: a re-request (open while open: ten more minutes), a retry, and a cancel of a
 * request still waiting (op 'none') are each just the next seq.
 */
export async function requestWifi(
  orgId: string, deviceId: string, action: WifiAction, ssid: string | null,
): Promise<RequestWifiOutcome> {
  const db = getDb();
  const scope = and(eq(devices.id, deviceId), eq(devices.orgId, orgId));
  const capable = isNotNull(devices.wifiNets);
  const guard = action === 'remove'
    ? sql`${ssid} = any(${devices.wifiNets}) and array_length(${devices.wifiNets}, 1) > 1
          and ${devices.wifiCurrent} is distinct from (array_position(${devices.wifiNets}, ${ssid}) - 1)`
    : action === 'cancel'
      ? sql`${devices.wifiSeq} > 0 and ${devices.wifiAck} is distinct from ${devices.wifiSeq}`
      : sql`true`;
  const [row] = await db.update(devices)
    .set({
      wifiSeq: sql`${devices.wifiSeq} + 1`,
      wifiOp: action === 'cancel' ? 'none' : action,
      // A cancel keeps what it withdrew (the op and a remove's name), so its answer is worded by it.
      wifiOpSsid: action === 'remove' ? ssid : action === 'cancel' ? sql`${devices.wifiOpSsid}` : null,
      wifiCancelled: action === 'cancel' ? sql`${devices.wifiOp}` : null,
      wifiOpAt: new Date(),
    })
    .where(and(scope, capable, guard))
    .returning({ seq: devices.wifiSeq });
  if (row) return { seq: row.seq };
  const [r] = await db.select({ nets: devices.wifiNets, current: devices.wifiCurrent }).from(devices).where(scope).limit(1);
  if (!r) return 'not_found';
  if (r.nets === null) return 'firmware_too_old';
  if (action === 'cancel') return 'nothing_to_cancel';
  const at = ssid ? r.nets.indexOf(ssid) : -1;
  if (at < 0) return 'not_saved';
  if (at === r.current) return 'in_use';
  return 'only_one';
}

/** What GET /api/device/wifi needs (deliverWifi). Not org-scoped: the caller is the board itself. */
export async function readWifiRow(deviceId: string): Promise<WifiRow | null> {
  const [row] = await getDb()
    .select({
      wifiSeq: devices.wifiSeq, wifiOp: devices.wifiOp, wifiOpSsid: devices.wifiOpSsid,
      wifiOpAt: devices.wifiOpAt, wifiAck: devices.wifiAck,
    })
    .from(devices).where(eq(devices.id, deviceId)).limit(1);
  return row ?? null;
}
