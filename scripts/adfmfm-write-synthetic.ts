// Writes the synthetic ADFs to a directory so the Python fixture generator can
// read them. TypeScript owns the definition; Python only ever consumes bytes,
// so the two cannot drift.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticAdf, type SyntheticKind } from '../src/lib/adfmfm/synthetic';

const dir = process.argv[2];
if (!dir) throw new Error('usage: adfmfm-write-synthetic.ts <out-dir>');
mkdirSync(dir, { recursive: true });

const kinds: SyntheticKind[] = ['zeros', 'ones', 'prng', 'bootblock'];
for (const kind of kinds) {
  const path = join(dir, `${kind}.adf`);
  writeFileSync(path, syntheticAdf(kind));
  console.log(`wrote ${path}`);
}
