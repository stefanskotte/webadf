import { describe, expect, it } from 'vitest';
import { defaultDeviceName, isDefaultDeviceName, pairingName, nameForNewBoard, DEVICE_NAME_MAX } from './device-name';

const MAC = '28:cd:c1:19:6a:38';

describe('defaultDeviceName', () => {
  it('is exactly what /api/device/register writes', () => {
    // If this ever diverges from register/route.ts, clearing an alias would
    // "reset" a device to a label it never had. That is the whole reason this
    // lives in one place.
    expect(defaultDeviceName(MAC)).toBe(`Device ${MAC}`);
  });

  it('still produces a usable label when the device has no MAC', () => {
    // devices.name is NOT NULL, so there is no option to produce nothing --
    // and "Device null" is what a naive template would give.
    expect(defaultDeviceName(null)).toBe('Device');
    expect(defaultDeviceName(null)).not.toContain('null');
  });
});

describe('isDefaultDeviceName', () => {
  it('recognises an unnamed device', () => {
    expect(isDefaultDeviceName(`Device ${MAC}`, MAC)).toBe(true);
  });

  it('recognises a named one', () => {
    expect(isDefaultDeviceName('Bench drive', MAC)).toBe(false);
  });

  it('does not mistake another device\'s default for this one\'s', () => {
    expect(isDefaultDeviceName('Device aa:bb:cc:dd:ee:ff', MAC)).toBe(false);
  });

  it('treats a MAC-less device consistently with defaultDeviceName', () => {
    expect(isDefaultDeviceName('Device', null)).toBe(true);
    expect(isDefaultDeviceName('Bench drive', null)).toBe(false);
  });
});

describe('a name given at pairing (plan 2026-10-17 Task 1, R8)', () => {
  it('is trimmed and loses control characters; empty means none', () => {
    expect(pairingName('  A500 study  ')).toBe('A500 study');
    expect(pairingName('A\u0000B\nC')).toBe('ABC');
    expect(pairingName('   ')).toBeNull();
    expect(pairingName(undefined)).toBeNull();
    expect(pairingName(null)).toBeNull();
  });
  it('names the new board, or it wears its MAC as before', () => {
    expect(nameForNewBoard('A500 study', MAC)).toBe('A500 study');
    expect(nameForNewBoard(null, MAC)).toBe(`Device ${MAC}`);
  });
  it('shares the rename limit', () => {
    expect(DEVICE_NAME_MAX).toBe(80);
  });
});
