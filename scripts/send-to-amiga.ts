// Bench tool (Phase 4): put a local file in the disk store and queue it for a board.
// Usage: pnpm tsx scripts/send-to-amiga.ts <deviceId> <file> [amigaPath]   (DATABASE_URL and storage from the env)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { diskStore } from '@/lib/storage';
import { queueTransferFromBlob } from '@/lib/transfers';

const [deviceId, file, amigaPath] = process.argv.slice(2);
if (!deviceId || !file) { console.error('usage: send-to-amiga <deviceId> <file> [amigaPath]'); process.exit(2); }
const bytes = new Uint8Array(readFileSync(file));
const sha = createHash('sha256').update(bytes).digest('hex');
if (!(await diskStore.stat(sha))) await diskStore.put(sha, bytes);
const db = getDb();
const [d] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId));
if (!d) { console.error('no such device'); process.exit(1); }
const r = await queueTransferFromBlob(db, { orgId: d.orgId, deviceId, userId: 'bench', path: amigaPath ?? basename(file), sha256: sha });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
