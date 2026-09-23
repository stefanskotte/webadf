import { describe, it, expect } from 'vitest';
import { liveFingerprint, type LiveStateRow } from './live-state';
import { STALE_AFTER_MS } from './device-state';

const NOW = 1_800_000_000_000;
const base: LiveStateRow = {
  id: 'dev-a', name: 'Bench',
  desiredDiskId: 'disk-1', desiredSha256: 'a'.repeat(64), desiredVersion: 4,
  mountedDiskId: 'disk-1', mountedSha256: 'a'.repeat(64), mountedVersion: 4,
  lastSeenAt: new Date(NOW - 5_000),
  diskSha256: 'a'.repeat(64), diskWriteProtected: false,
  mountedDiskWriteProtected: true,
  firmwareVersion: '1.0.0',
  desiredFirmwareVersion: null, firmwareUpdateState: null,
  updateProtocol: null, firmwareUpdateError: null,
  lastError: null, lastErrorAt: null,
};
const other: LiveStateRow = { ...base, id: 'dev-b', name: 'Second' };
const fp = (rows: LiveStateRow[], now = NOW) => liveFingerprint(rows, now, 0);

describe('liveFingerprint', () => {
  it('is 16 hex characters and stable across row order', () => {
    expect(fp([base, other])).toMatch(/^[0-9a-f]{16}$/);
    expect(fp([base, other])).toBe(fp([other, base]));
  });

  it.each([
    ['desired disk', { desiredDiskId: 'disk-2' }],
    ['desired digest', { desiredSha256: 'b'.repeat(64) }],
    ['desired version', { desiredVersion: 5 }],
    ['mounted disk id', { mountedDiskId: 'disk-2' }],
    ['mounted digest', { mountedSha256: 'c'.repeat(64) }],
    ['mounted version', { mountedVersion: 5 }],
    ['write-protect', { diskWriteProtected: true }],
    // The Devices card's bottom tag ("Protected"/"Writable") reads the
    // MOUNTED disk's flag, not the desired disk's above -- a flip there must
    // move the fingerprint on its own, or every open tab misses it.
    ['the mounted disk\'s write-protect', { mountedDiskWriteProtected: false }],
    ['the disk digest (a board write)', { diskSha256: 'd'.repeat(64) }],
    ['the device name', { name: 'Renamed' }],
    ['the firmware version', { firmwareVersion: '1.1.0' }],
    ['the last error', { lastError: 'SPI timeout' }],
    ['the last error timestamp', { lastErrorAt: new Date(NOW) }],
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

  it('changes when a converged device crosses the online threshold', () => {
    // base is converged (desired === mounted), so deviceState() itself never
    // moves here -- only the online/offline boundary the header count reads.
    const justOnline = { ...base, lastSeenAt: new Date(NOW - (STALE_AFTER_MS - 1_000)) };
    const justOffline = { ...base, lastSeenAt: new Date(NOW - (STALE_AFTER_MS + 1_000)) };
    expect(fp([justOnline], NOW)).not.toBe(fp([justOffline], NOW));
  });

  it("changes when a stale device's relative-time text changes", () => {
    // Diverged and long past the threshold at both points below, so
    // deviceState() stays 'stale' throughout -- only the "Nm ago" text moves.
    const stale = { ...base, mountedSha256: null, mountedVersion: null, lastSeenAt: new Date(NOW) };
    expect(fp([stale], NOW + 5 * 60_000)).not.toBe(fp([stale], NOW + 6 * 60_000));
  });

  it('distinguishes no devices from one device', () => {
    expect(fp([])).not.toBe(fp([base]));
  });
});

/**
 * /devices renders its firmware verdict from two inputs -- the device's
 * reported version and the release registry -- and only the first used to be
 * in here. Publishing a release changed what every open tab should show while
 * leaving the fingerprint identical, so the callout appeared only on a manual
 * reload. That also broke this function's own stated contract: "a change here
 * means some page would render differently, and nothing else changes it."
 */
describe('the release registry', () => {
  it('changes the fingerprint when a release is published', () => {
    expect(liveFingerprint([base], NOW, 3)).not.toBe(liveFingerprint([base], NOW, 4));
  });

  it('does not change it when the registry has not moved', () => {
    expect(liveFingerprint([base], NOW, 4)).toBe(liveFingerprint([base], NOW, 4));
  });

  it('distinguishes an empty registry from a published one', () => {
    expect(liveFingerprint([base], NOW, 0)).not.toBe(liveFingerprint([base], NOW, 1));
  });

  /**
   * Both of these are rendered by /devices and both were missed when the
   * update fields were first added -- the same gap, in the same file, twice.
   */
  it('changes when the capability or the failure reason moves', () => {
    const capable: LiveStateRow = { ...base, updateProtocol: 1 };
    const failed: LiveStateRow = {
      ...base, desiredFirmwareVersion: '1.2.0+gc', firmwareUpdateState: 'failed',
      firmwareUpdateError: 'signature mismatch',
    };
    const failedDifferently: LiveStateRow = { ...failed, firmwareUpdateError: 'short read' };
    expect(fp([base])).not.toBe(fp([capable]));
    expect(fp([failed])).not.toBe(fp([failedDifferently]));
  });
});

describe('an update in flight', () => {
  it('changes the fingerprint when one is requested, and as its state moves', () => {
    const pending: LiveStateRow = { ...base, desiredFirmwareVersion: '1.2.0+gc333333' };
    const downloading: LiveStateRow = { ...pending, firmwareUpdateState: 'downloading' };
    expect(fp([base])).not.toBe(fp([pending]));
    expect(fp([pending])).not.toBe(fp([downloading]));
  });
});
