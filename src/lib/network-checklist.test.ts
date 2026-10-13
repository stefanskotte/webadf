import { describe, it, expect } from 'vitest';
import { driverDiskLine, driverLine, amigaAddressLine, trafficText, driverBucket } from './network-checklist';
import { PAULANET_DISK_SHA256 } from './paulanet-disk';

const NOW = 1_800_000_000_000;

describe('the Network checklist names both values of every state', () => {
  it('driver disk: in DF1 or loading, whatever DF0 holds (ruling 6)', () => {
    expect(driverDiskLine({ df1Sha256: PAULANET_DISK_SHA256 })).toEqual({ ok: true, text: 'Driver disk: in DF1' });
    expect(driverDiskLine({ df1Sha256: null })).toEqual({ ok: false, text: 'Driver disk: loading' });
    expect(driverDiskLine({ df1Sha256: 'b'.repeat(64) })).toEqual({ ok: false, text: 'Driver disk: loading' });
  });
  it('driver: talking, never heard, and quiet', () => {
    expect(driverLine(new Date(NOW - 4_000), NOW)).toEqual({ ok: true, text: 'Driver: talking (last seen 4 s ago)' });
    expect(driverLine(null, NOW))
      .toEqual({ ok: false, text: 'Driver: not heard from yet — run Install, then AddNetInterface eth0' });
    expect(driverLine(new Date(NOW - 120_000), NOW).ok).toBe(true);
    expect(driverLine(new Date(NOW - 121_000), NOW))
      .toEqual({ ok: false, text: 'Driver: not heard from for 2 min — run AddNetInterface eth0' });
    expect(driverLine(new Date(NOW + 3_000), NOW).text).toBe('Driver: talking (last seen 0 s ago)');   // clock skew
  });
  it('the age keeps counting as the clock advances, and flips at the threshold', () => {
    const seen = new Date(NOW);
    expect(driverLine(seen, NOW + 5_000).text).toBe('Driver: talking (last seen 5 s ago)');
    expect(driverLine(seen, NOW + 60_000).text).toBe('Driver: talking (last seen 60 s ago)');
    expect(driverLine(seen, NOW + 180_000).text).toBe('Driver: not heard from for 3 min — run AddNetInterface eth0');
  });
  it('Amiga address: the address, or none yet', () => {
    expect(amigaAddressLine('172.16.10.231')).toEqual({ ok: true, text: 'Amiga address: 172.16.10.231' });
    expect(amigaAddressLine(null)).toEqual({ ok: false, text: 'Amiga address: none yet' });
  });
  it('traffic only when frames move', () => {
    expect(trafficText(null, null)).toBeNull();
    expect(trafficText(0, 0)).toBeNull();
    expect(trafficText(1234, 56)).toBe('Traffic: 1,234 frames from the Amiga, 56 to it');
  });
  it('the fingerprint bucket', () => {
    expect(driverBucket(null, NOW)).toBe('never');
    expect(driverBucket(new Date(NOW - 5_000), NOW)).toBe('talking');
    expect(driverBucket(new Date(NOW - 600_000), NOW)).toBe('quiet');
  });
});
