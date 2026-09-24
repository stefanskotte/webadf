// Writes the synthetic images Greaseweazle converts into the committed HFE
// fixtures. TypeScript owns the content; gw only ever consumes bytes, so the
// two cannot drift. See src/lib/hfe/__fixtures__/README.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sparseAdf } from '../src/lib/hfe/__fixtures__/source';

const dir = process.argv[2];
if (!dir) throw new Error('usage: hfe-write-sources.ts <out-dir>');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'sparse.adf'), sparseAdf());
// A PC 720 KB image: the non-Amiga fixture. Content is irrelevant; its
// track 0 is IBM MFM, which is the point.
writeFileSync(join(dir, 'pc.img'), new Uint8Array(737_280));
console.log(`wrote ${dir}/sparse.adf and ${dir}/pc.img`);
