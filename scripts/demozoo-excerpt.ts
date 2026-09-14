// Cut the committed Demozoo test fixture from a LOCAL export file.
//   npx tsx scripts/demozoo-excerpt.ts /path/to/demozoo-export.sql.gz
// Keeps, for the productions below: their production, platform, type, author
// and screenshot rows, plus every productiontype and platform row and the nicks
// they reference. Also keeps one non-Amiga production to prove filtering.
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { readCopyBlocks, parseCopyHeader } from '../src/lib/demozoo/copy';
import { gzipLines } from '../src/lib/demozoo/lines';

// Spike cases (spec §0): 9 Fingers, State of the Art, Wayfarer, Global Trash,
// Ray of Hope 2, Glide's "state-of-the-art" (music), Alien Breed II cracktro.
// 188557 "Megademo 4" (Kefrens/7up Crew, 1988) covers spec §10: a real
// production with several types (Demo, Pack) and several authors (Kefrens,
// 7up Crew), found by scanning the local export for Amiga productions with
// >=2 productiontype rows and >=2 author_nicks rows.
const KEEP = new Set(['89', '2', '4162', '710', '737', '218264', '243512', '188557']);
const TABLES = [
  'platforms_platform', 'productions_productiontype', 'productions_production',
  'productions_production_platforms', 'productions_production_types',
  'productions_production_author_nicks', 'demoscene_nick', 'productions_screenshot',
];

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: demozoo-excerpt.ts <export.sql.gz>');
  const open = () => gzipLines(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>);

  // Pass 1: headers, which nicks and which non-Amiga production to keep.
  const headers = new Map<string, string>();
  const nickIds = new Set<string>();
  const amigaPlatforms = new Set<string>();
  const amigaProds = new Set<string>();
  let nonAmiga: string | null = null;
  for await (const line of open()) {
    const h = parseCopyHeader(line);
    if (h && TABLES.includes(h.table)) headers.set(h.table, line);
  }
  for await (const { table, row } of readCopyBlocks(open(), new Set(TABLES))) {
    if (table === 'platforms_platform' && /amiga/i.test(row.name ?? '')) amigaPlatforms.add(row.id!);
    if (table === 'productions_production_platforms' && amigaPlatforms.has(row.platform_id!)) amigaProds.add(row.production_id!);
    if (table === 'productions_production_author_nicks' && KEEP.has(row.production_id!)) nickIds.add(row.nick_id!);
  }
  for await (const { row } of readCopyBlocks(open(), new Set(['productions_production_platforms']))) {
    if (!amigaProds.has(row.production_id!)) { nonAmiga = row.production_id!; break; }
  }
  if (nonAmiga) KEEP.add(nonAmiga);

  // Pass 2: collect kept rows as raw COPY lines, preserving escapes.
  const out = new Map<string, string[]>(TABLES.map((t) => [t, []]));
  let table: string | null = null;
  for await (const line of open()) {
    if (table === null) {
      const h = parseCopyHeader(line);
      if (h && TABLES.includes(h.table)) table = h.table;
      continue;
    }
    if (line === '\\.') { table = null; continue; }
    const f = line.split('\t');
    const keep =
      table === 'platforms_platform' || table === 'productions_productiontype'
      || (table === 'productions_production' && KEEP.has(f[0]))
      || (table === 'demoscene_nick' && nickIds.has(f[0]))
      || (table !== 'productions_production' && table !== 'demoscene_nick' && KEEP.has(f[1]));
    if (keep) out.get(table)!.push(line);
  }

  mkdirSync('src/lib/demozoo/fixtures', { recursive: true });
  const text = TABLES.map((t) => [headers.get(t)!, ...out.get(t)!, '\\.'].join('\n')).join('\n') + '\n';
  writeFileSync('src/lib/demozoo/fixtures/excerpt.sql', text);
  console.log('wrote excerpt:', TABLES.map((t) => `${t}=${out.get(t)!.length}`).join(' '), 'nonAmiga', nonAmiga);
}
main();
