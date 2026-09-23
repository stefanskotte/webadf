import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pubkeyHeader, fixtureHeader } from '@/lib/firmware-c-headers';

const fw = join(process.cwd(), 'wifi-floppy', 'firmware');
const pems = readdirSync(join(fw, 'keys')).filter((f) => f.endsWith('.pem'));
if (pems.length !== 1) throw new Error(`expected exactly one key in keys/, found ${pems.length}`);
writeFileSync(join(fw, 'src', 'fw_pubkey.h'), pubkeyHeader(readFileSync(join(fw, 'keys', pems[0]), 'utf8')));
writeFileSync(join(fw, 'test', 'fw_fixture.h'), fixtureHeader());
console.log('wrote src/fw_pubkey.h and test/fw_fixture.h');
