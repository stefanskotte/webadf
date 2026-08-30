import { describe, it, expect } from 'vitest';
import { deviceState, STALE_AFTER_MS, type DeviceStateRow } from './device-state';

const NOW = new Date('2026-08-30T12:00:00Z').getTime();
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const seenAgo = (ms: number) => new Date(NOW - ms);

function row(p: Partial<DeviceStateRow> = {}): DeviceStateRow {
  return { desiredSha256: null, mountedSha256: null, lastSeenAt: seenAgo(1_000), ...p };
}

describe('deviceState', () => {
  it('is empty when nothing is desired and nothing is held', () => {
    expect(deviceState(row(), NOW)).toBe('empty');
  });

  it('is empty even for a long-unseen device holding nothing', () => {
    // Staleness only qualifies a DIVERGENCE. With nothing desired there is
    // nothing pending, so "no disk" is the whole truth however old the contact.
    expect(deviceState(row({ lastSeenAt: seenAgo(86_400_000) }), NOW)).toBe('empty');
    expect(deviceState(row({ lastSeenAt: null }), NOW)).toBe('empty');
  });

  it('is converged when desired and mounted match', () => {
    expect(deviceState(row({ desiredSha256: A, mountedSha256: A }), NOW)).toBe('converged');
  });

  it('is converged for a matching pair even if the device has not been seen lately', () => {
    // It reached the state we asked for. Silence afterwards does not undo that.
    expect(deviceState(row({ desiredSha256: A, mountedSha256: A, lastSeenAt: seenAgo(86_400_000) }), NOW))
      .toBe('converged');
  });

  it('is pending when they differ and the device was seen recently', () => {
    expect(deviceState(row({ desiredSha256: B, mountedSha256: A }), NOW)).toBe('pending');
  });

  it('is pending when a disk is desired and none is held yet', () => {
    expect(deviceState(row({ desiredSha256: A, mountedSha256: null }), NOW)).toBe('pending');
  });

  it('is pending when an eject is desired and a disk is still held', () => {
    expect(deviceState(row({ desiredSha256: null, mountedSha256: A }), NOW)).toBe('pending');
  });

  it('is stale when they differ and contact is older than the threshold', () => {
    expect(deviceState(row({ desiredSha256: B, mountedSha256: A, lastSeenAt: seenAgo(STALE_AFTER_MS + 1) }), NOW))
      .toBe('stale');
  });

  it('is stale when they differ and the device has never been seen', () => {
    expect(deviceState(row({ desiredSha256: A, mountedSha256: null, lastSeenAt: null }), NOW)).toBe('stale');
  });

  it('treats exactly the threshold as still pending, not stale', () => {
    // The boundary is a real decision: at exactly 60s a device that polled on
    // schedule has not yet missed anything. Only past it has it gone quiet.
    const at = row({ desiredSha256: B, mountedSha256: A, lastSeenAt: seenAgo(STALE_AFTER_MS) });
    expect(deviceState(at, NOW)).toBe('pending');
    const past = row({ desiredSha256: B, mountedSha256: A, lastSeenAt: seenAgo(STALE_AFTER_MS + 1) });
    expect(deviceState(past, NOW)).toBe('stale');
  });

  it('derives the threshold from the protocol, not from taste', () => {
    // The poll holds 25s and refreshes last_seen_at once per request, so a
    // healthy device checks in at least every 25s. 60s is two missed polls
    // plus slack. If the hold ever changes, this number must be revisited.
    expect(STALE_AFTER_MS).toBe(60_000);
  });
});
