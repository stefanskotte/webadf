import { describe, it, expect } from 'vitest';
import { updateStateSchema, updateProtocolSchema, UPDATE_STATES } from './firmware-update-state';

describe('updateStateSchema', () => {
  it('accepts exactly the four states a device may report', () => {
    expect(UPDATE_STATES).toEqual(['queued', 'downloading', 'applying', 'failed']);
    for (const s of UPDATE_STATES) expect(updateStateSchema.safeParse(s).success, s).toBe(true);
  });

  /**
   * There is deliberately no 'succeeded'. Completion is derived from the
   * version the board actually reports running -- a device that reports
   * success is a device that can be wrong about it.
   */
  it('has no success state', () => {
    expect(updateStateSchema.safeParse('succeeded').success).toBe(false);
    expect(updateStateSchema.safeParse('done').success).toBe(false);
  });
});

describe('updateProtocolSchema', () => {
  it('accepts a small integer capability level', () => {
    expect(updateProtocolSchema.safeParse(1).success).toBe(true);
    expect(updateProtocolSchema.safeParse(0).success).toBe(true);
  });

  // Telemetry must never be able to reject the whole report, but it also must
  // not accept a value that could only come from a confused board.
  it('refuses a negative or absurd level', () => {
    expect(updateProtocolSchema.safeParse(-1).success).toBe(false);
    expect(updateProtocolSchema.safeParse(9999).success).toBe(false);
    expect(updateProtocolSchema.safeParse(1.5).success).toBe(false);
  });
});
