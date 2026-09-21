import { describe, it, expect } from 'vitest';
import { firmwareVersionSchema, FIRMWARE_VERSION_MAX } from './firmware-version';

describe('firmwareVersionSchema', () => {
  it('bounds a version at the shared maximum', () => {
    expect(FIRMWARE_VERSION_MAX).toBe(64);
    expect(firmwareVersionSchema.safeParse('v'.repeat(FIRMWARE_VERSION_MAX)).success).toBe(true);
    expect(firmwareVersionSchema.safeParse('v'.repeat(FIRMWARE_VERSION_MAX + 1)).success).toBe(false);
  });

  it('accepts the shape the firmware actually produces', () => {
    for (const v of ['1.0.0+gd16a1da', '1.0.0+gd16a1da-dirty', '1.0.0+nogit', '4b.0-dev']) {
      expect(firmwareVersionSchema.safeParse(v).success, v).toBe(true);
    }
  });

  it('rejects an empty version, which is not a reading', () => {
    expect(firmwareVersionSchema.safeParse('').success).toBe(false);
  });

  /**
   * The firmware's DC_STATUS_VER_BYTES is this number plus a terminator. If
   * one moves without the other, a board can compose a version the server
   * then rejects -- and a rejected status body is a heartbeat that silently
   * stops. Asserted here because the two live in different languages and
   * nothing else would notice them drifting apart.
   */
  it('matches the firmware buffer it is paired with', async () => {
    const { readFileSync } = await import('node:fs');
    const header = readFileSync('wifi-floppy/firmware/src/device_client.h', 'utf8');
    const m = /#define DC_STATUS_VER_BYTES\s+(\d+)/.exec(header);
    expect(m, 'DC_STATUS_VER_BYTES not found in device_client.h').not.toBeNull();
    expect(Number(m![1])).toBe(FIRMWARE_VERSION_MAX + 1);
  });
});
