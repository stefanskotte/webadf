import { describe, it, expect } from 'vitest';
import { liveFingerprint, type LiveStateRow } from './live-state';
import { STALE_AFTER_MS } from './device-state';

const NOW = 1_800_000_000_000;
const base: LiveStateRow = {
  id: 'dev-a', name: 'Bench',
  desiredDiskId: 'disk-1', desiredSha256: 'a'.repeat(64), desiredVersion: 4,
  mountedSha256: 'a'.repeat(64), mountedVersion: 4, lastSeenAt: new Date(NOW - 5_000),
  diskSha256: 'a'.repeat(64), diskWriteProtected: false,
};
const other: LiveStateRow = { ...base, id: 'dev-b', name: 'Second' };
const fp = (rows: LiveStateRow[], now = NOW) => liveFingerprint(rows, now);

describe('liveFingerprint', () => {
  it('is 16 hex characters and stable across row order', () => {
    expect(fp([base, other])).toMatch(/^[0-9a-f]{16}$/);
    expect(fp([base, other])).toBe(fp([other, base]));
  });

  it.each([
    ['desired disk', { desiredDiskId: 'disk-2' }],
    ['desired digest', { desiredSha256: 'b'.repeat(64) }],
    ['desired version', { desiredVersion: 5 }],
    ['mounted digest', { mountedSha256: 'c'.repeat(64) }],
    ['mounted version', { mountedVersion: 5 }],
    ['write-protect', { diskWriteProtected: true }],
    ['the disk digest (a board write)', { diskSha256: 'd'.repeat(64) }],
    ['the device name', { name: 'Renamed' }],
  ] as const)('changes when the %s changes', (_what, patch) => {
    expect(fp([{ ...base, ...patch }])).not.toBe(fp([base]));
  });

  it('changes when time alone moves a device past the stale threshold', () => {
    // Pending (desired != mounted) reads differently when the device goes quiet.
    const pending = { ...base, mountedSha256: null, mountedVersion: null };
    expect(fp([pending], NOW)).not.toBe(fp([pending], NOW + STALE_AFTER_MS + 1));
  });

  it('does not change when only lastSeenAt moves within the threshold', () => {
    expect(fp([{ ...base, lastSeenAt: new Date(NOW - 20_000) }]))
      .toBe(fp([{ ...base, lastSeenAt: new Date(NOW - 1_000) }]));
  });

  it('distinguishes no devices from one device', () => {
    expect(fp([])).not.toBe(fp([base]));
  });
});
