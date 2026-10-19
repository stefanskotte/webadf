import { describe, it, expect } from 'vitest';
import { NFC_FAIL_RE } from './fail';

// The board's nfcFail (fw 1.18.2, nfc_ui_why): `why`, and on a PN532 ":0x<status>@<command>", upper-case hex.
describe('NFC_FAIL_RE', () => {
  it.each(['locked', 'moved', 'verify', 'bad data', 'locked:0x14@A2', 'moved:0x01@30', 'bad data:0xFF@A0'])(
    'takes %s', (r) => expect(NFC_FAIL_RE.test(r)).toBe(true));
  it.each(['', 'LOCKED', 'locked:0x14', 'locked:0x1@A2', 'locked:0x14@a2', 'locked:14@A2', 'locked:0x14@A2x',
    '<script>', 'locked\nINFO fake log line', 'a b c', ' locked'])(
    'refuses %j', (r) => expect(NFC_FAIL_RE.test(r)).toBe(false));
});
