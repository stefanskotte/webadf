import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DC_TITLE_MAX, DC_LABEL_MAX } from './device-limits';
import { FIRMWARE_VERSION_MAX } from './firmware-version';

const header = readFileSync('wifi-floppy/firmware/src/device_client.h', 'utf8');
const define = (name: string): number => {
  const m = new RegExp(`#define ${name}\\s+(\\d+)`).exec(header);
  expect(m, `${name} not found in device_client.h`).not.toBeNull();
  return Number(m![1]);
};

describe('the firmware bounds the server respects', () => {
  it('matches the C header, which is the source of truth', () => {
    expect(DC_TITLE_MAX).toBe(define('DC_TITLE_MAX'));
    expect(DC_LABEL_MAX).toBe(define('DC_LABEL_MAX'));
  });

  /**
   * The check that matters. The firmware refuses a truncated poll body
   * OUTRIGHT -- it does not parse a prefix -- so a body over the buffer does
   * not cost the last field, it costs the whole instruction: the board stops
   * mounting and ejecting, and because it can never parse the body it can
   * never report anything either.
   *
   * Computed from the real worst case rather than eyeballed, so the next
   * field added to this body fails a test instead of failing a board.
   */
  it('leaves the worst-case poll body inside DC_POLL_BODY_BYTES', () => {
    const SHA = 64, ID = 64;
    const disk =
      '{"version":4294967295'
      + `,"desired":{"sha256":"${'a'.repeat(SHA)}"`
      + `,"diskId":"${'b'.repeat(ID)}"`
      + `,"gameId":"${'c'.repeat(ID)}"`
      + `,"game":"${'G'.repeat(DC_TITLE_MAX)}"`
      + ',"diskNo":4294967295,"diskCount":4294967295'
      + `,"label":"${'L'.repeat(DC_LABEL_MAX)}"`
      + ',"writeProtected":false}';
    const update =
      `,"update":{"version":"${'v'.repeat(FIRMWARE_VERSION_MAX)}"`
      + ',"sequence":4294967295'
      + `,"sha256":"${'d'.repeat(SHA)}"`
      + ',"sizeBytes":4294967295'
      // ed25519 signature, base64: 64 bytes -> 88 chars.
      + `,"signature":"${'s'.repeat(88)}"`
      + `,"keyId":"${'k'.repeat(64)}"`
      + ',"instructionVersion":4294967295}}';

    const worst = (disk + update).length;
    const budget = define('DC_POLL_BODY_BYTES');
    // Reported rather than just asserted, so a future reader sees the margin
    // instead of rediscovering it.
    expect(worst, `worst-case body ${worst} bytes against a ${budget}-byte buffer`)
      .toBeLessThan(budget);
  });
});
