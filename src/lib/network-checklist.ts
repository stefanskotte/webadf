import { DRIVER_TALKING_MS, PAULANET_DISK_PREVIOUS, PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

// The card's Network checklist (spec 2026-10-12 §5): every line names its good and its bad state in words.

/** Two heartbeats: within this the driver is "talking" (defined in paulanet-disk.ts, which driverDiskFor shares). */
export { DRIVER_TALKING_MS };

export type Line = { ok: boolean; text: string };

/** DF1 holds the driver disk in a slot of its own, whatever DF0 holds (plan 2026-10-12 ruling 6); the older disk
 *  counts as in DF1 too, until the Amiga is off (R16, driverDiskFor). */
export function driverDiskLine(d: { df1Sha256: string | null }): Line {
  if (d.df1Sha256 === PAULANET_DISK_SHA256) return { ok: true, text: 'Driver disk: in DF1' };
  if (d.df1Sha256 === PAULANET_DISK_PREVIOUS) {
    return { ok: true, text: 'Driver disk: in DF1 (the older one, without Receive; the new one goes in once the Amiga is off)' };
  }
  return { ok: false, text: 'Driver disk: loading' };
}

export function driverLine(seenAt: Date | null, now: number): Line {
  if (!seenAt) return { ok: false, text: 'Driver: not heard from yet — run Install, then AddNetInterface eth0' };
  const age = Math.max(0, now - seenAt.getTime());
  if (age <= DRIVER_TALKING_MS) return { ok: true, text: `Driver: talking (last seen ${Math.round(age / 1000)} s ago)` };
  return { ok: false, text: `Driver: not heard from for ${Math.round(age / 60_000)} min — run AddNetInterface eth0` };
}

export function amigaAddressLine(ip: string | null): Line {
  return ip ? { ok: true, text: `Amiga address: ${ip}` } : { ok: false, text: 'Amiga address: none yet' };
}

/** framesIn = from the Amiga, framesOut = to it (plan 2026-10-12 ruling 13); null while nothing has moved. */
export function trafficText(framesIn: number | null, framesOut: number | null): string | null {
  const a = framesIn ?? 0, b = framesOut ?? 0;
  if (a === 0 && b === 0) return null;
  return `Traffic: ${a.toLocaleString('en-US')} frames from the Amiga, ${b.toLocaleString('en-US')} to it`;
}

/** What the live fingerprint tracks of the driver: its state, not every heartbeat's timestamp. */
export function driverBucket(seenAt: Date | null, now: number): 'talking' | 'quiet' | 'never' {
  if (!seenAt) return 'never';
  return now - seenAt.getTime() <= DRIVER_TALKING_MS ? 'talking' : 'quiet';
}
