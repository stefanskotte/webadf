import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pubkeyHeader, fixtureHeader } from '@/lib/firmware-c-headers';

const fw = join(process.cwd(), 'wifi-floppy', 'firmware');

describe('generated firmware headers', () => {
  it('fw_pubkey.h is the committed key, byte for byte', () => {
    const pem = readdirSync(join(fw, 'keys')).find((f) => f.endsWith('.pem'))!;
    expect(readFileSync(join(fw, 'src', 'fw_pubkey.h'), 'utf8'))
      .toBe(pubkeyHeader(readFileSync(join(fw, 'keys', pem), 'utf8')));
  });
  it('names the key by the same id the publish script records', () => {
    expect(readFileSync(join(fw, 'src', 'fw_pubkey.h'), 'utf8')).toContain('"wf-1138f25902223da4"');
  });
  it('test/fw_fixture.h has not drifted from the manifest the server builds', () => {
    expect(readFileSync(join(fw, 'test', 'fw_fixture.h'), 'utf8')).toBe(fixtureHeader());
  });
});
