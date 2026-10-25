import { describe, it, expect } from 'vitest';
import { driverDiskLine, driverLine, amigaAddressLine, trafficText, driverBucket, splitCheckLine } from './network-checklist';
import { PAULANET_DISK_PREVIOUS, PAULANET_DISK_SHA256 } from './paulanet-disk';

const NOW = 1_800_000_000_000;

describe('the Network checklist names both values of every state', () => {
  it('driver disk: in DF1 or loading, whatever DF0 holds (ruling 6)', () => {
    expect(driverDiskLine({ df1Sha256: PAULANET_DISK_SHA256 })).toEqual({ ok: true, text: 'Driver disk: in DF1' });
    expect(driverDiskLine({ df1Sha256: null })).toEqual({ ok: false, text: 'Driver disk: loading' });
    expect(driverDiskLine({ df1Sha256: 'b'.repeat(64) })).toEqual({ ok: false, text: 'Driver disk: loading' });
  });
  it('names the older driver disk as in DF1, and says when the new one goes in (R16)', () => {
    expect(driverDiskLine({ df1Sha256: PAULANET_DISK_PREVIOUS }))
      .toEqual({ ok: true, text: 'Driver disk: in DF1 (an older one; the new one goes in once the Amiga is off)' });
    expect(driverDiskLine({ df1Sha256: '05170a83c279157fc50a2a9a595f4caf1ec194253127d93232f6fd5bfc008c9e' }).ok).toBe(true);
    expect(driverDiskLine({ df1Sha256: 'fb363d45c3b6c26592ada627c1cddc68b32c93c003a82328617a487dce5aa287' }).ok).toBe(true);
    expect(driverDiskLine({ df1Sha256: '1ca4f4cb402042e9c842bcf7af91fb86cf5587125ba64134b26f4d25d35a352d' }).ok).toBe(true);
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

describe('splitCheckLine (Devices spec §6)', () => {
  it('splits at the first ": "', () => {
    expect(splitCheckLine('Driver disk: in DF1')).toEqual({ label: 'Driver disk', detail: 'in DF1' });
    expect(splitCheckLine('Driver: talking (last seen 12 s ago)')).toEqual({ label: 'Driver', detail: 'talking (last seen 12 s ago)' });
    expect(splitCheckLine('Amiga address: 172.16.10.231')).toEqual({ label: 'Amiga address', detail: '172.16.10.231' });
  });
  it('keeps later colons in the detail', () => {
    expect(splitCheckLine('A: b: c')).toEqual({ label: 'A', detail: 'b: c' });
  });
  it('renders a line without ": " whole', () => {
    expect(splitCheckLine('Nothing here')).toEqual({ label: null, detail: 'Nothing here' });
  });
});
