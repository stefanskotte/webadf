/** Ad-hoc: check specific AmigaDOS blocks of a mounted disk image. */
import { like, eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import { disks, games } from '../src/db/schema/catalog';
import { diskStore } from '../src/lib/storage';

const prefix = process.argv[2] ?? '';
const blocks = process.argv.slice(3).map(Number);

const rows = await getDb()
  .select({ id: disks.id, sha: disks.sha256, label: disks.label, g: games.title })
  .from(disks).leftJoin(games, eq(games.id, disks.gameId))
  .where(like(disks.sha256, `${prefix}%`));
if (!rows.length) { console.log('no disk matching', prefix); process.exit(1); }
const d = rows[0];
console.log(`disk: ${d.g} / ${d.label}   sha ${d.sha.slice(0, 16)}…`);

const adf = await diskStore.read(d.sha);
console.log(`image: ${adf.length} bytes`);
const blk = (n: number) => adf.subarray(n * 512, (n + 1) * 512);
const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const be32 = (b: Uint8Array, at: number) =>
  ((b[at] << 24) | (b[at+1] << 16) | (b[at+2] << 8) | b[at+3]) >>> 0;
/** AmigaDOS: the 32-bit sum of a block's longs is zero when it is intact. */
const sum = (b: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < 512; i += 4) s = (s + be32(b, i)) >>> 0;
  return s >>> 0;
};

for (const n of blocks) {
  const b = blk(n);
  console.log(`block ${n}: type=0x${be32(b,0).toString(16).padStart(8,'0')} ` +
              `allZero=${isZero(b)} checksum=${sum(b) === 0 ? 'OK' : '0x'+sum(b).toString(16)} ` +
              `track=${Math.floor(n/11)} cyl=${Math.floor(n/22)} side=${Math.floor(n/11)%2}`);
}
let last = -1;
for (let n = 1759; n >= 0; n--) if (!isZero(blk(n))) { last = n; break; }
let blanks = 0;
for (let n = 0; n < 1760; n++) if (isZero(blk(n))) blanks++;
console.log(`\nhighest non-empty block: ${last}/1759   entirely-zero blocks: ${blanks}`);
process.exit(0);
