import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

// The card's Network checklist (spec 2026-10-12 §5): every line names its good and its bad state in words.

/** Two heartbeats (60 s each, device_client.h DC_STATUS_PERIOD_MS): within this the driver is "talking". */
export const DRIVER_TALKING_MS = 120_000;

export type Line = { ok: boolean; text: string };

/** DF1 holds the driver disk in a slot of its own, whatever DF0 holds (plan 2026-10-12 ruling 6). */
export function driverDiskLine(d: { df1Sha256: string | null }): Line {
  return d.df1Sha256 === PAULANET_DISK_SHA256
    ? { ok: true, text: 'Driver disk: in DF1' }
    : { ok: false, text: 'Driver disk: loading' };
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
