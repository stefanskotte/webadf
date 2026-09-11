import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, entitlements } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import {
  readVolume, readUsage, applyBatch, blocksForPlan,
  type CostItem, type BatchOp,
} from '@/lib/adffs';
import { applyDiskEdit } from '@/lib/disk-write';

export const maxDuration = 60;

// A manifest entry names its op and its full path from the disk's root
// (e.g. "C/Assign"), never a block number -- exactly the reason `BatchOp`
// itself uses `parentPath` (write.ts): a directory this same request is
// about to create has no block number the client could possibly know yet.
const manifestEntry = z.discriminatedUnion('op', [
  z.object({ op: z.literal('mkdir'), path: z.string().trim().min(1) }),
  // `protection` is the AmigaDOS bit mask an .lha carried for this file, when
  // it carried one. Optional and unsigned-32 bounded; absent means the writer
  // applies the AmigaDOS default rather than inventing bits.
  z.object({ op: z.literal('add'), path: z.string().trim().min(1),
             protection: z.number().int().min(0).max(0xffffffff).optional() }),
  z.object({ op: z.literal('replace'), path: z.string().trim().min(1),
             protection: z.number().int().min(0).max(0xffffffff).optional() }),
]);
const manifestSchema = z.array(manifestEntry).min(1);

/** Split "C/Assign" into { parentPath: "C", name: "Assign" }; a bare "C" into { parentPath: "", name: "C" } -- matching how `applyBatch` seeds `''` to mean the disk's root. */
function splitPath(path: string): { parentPath: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { parentPath: '', name: path }
    : { parentPath: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** Segment count -- "C" is 1, "C/Assign" is 2 -- the sort key that puts every parent before its children (§5 of the design doc). */
function depthOf(path: string): number {
  return path.split('/').length;
}

/** Every leg of the path must be a real segment: non-empty, and never "." or ".." -- the same shape a filename must have, applied leg by leg. */
function isPathSafe(path: string): boolean {
  return path.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');
}

/**
 * Drop a whole folder onto a disk in ONE commit (design §5, D-DD-3).
 *
 * The request is multipart: a `manifest` part carrying the JSON op list
 * above, plus one `File` part per `add`/`replace` entry, keyed by that
 * entry's own `path`. `mkdir` entries carry no file part.
 *
 * Three things happen, strictly in this order:
 *
 *  1. Sort by path depth, so `applyBatch` -- which resolves each op's
 *     parent from directories already registered, never by reordering its
 *     own input -- sees every parent before the children that name it.
 *  2. A PRE-FLIGHT capacity check against the disk's CURRENT bytes: free
 *     space is blocks, never bytes (§3.1), and this check runs before
 *     `applyDiskEdit` is even called, so a batch that cannot fit is
 *     refused rather than committed-then-failed.
 *  3. `applyDiskEdit(orgId, id, applyBatch(ops))`, which is what actually
 *     inherits the 409-when-mounted refusal, the 404-never-403 tenancy
 *     boundary and the one-blob-per-commit rule -- this route does nothing
 *     resembling a database write of its own.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }

  const manifestField = form.get('manifest');
  if (typeof manifestField !== 'string') {
    return Response.json({ error: 'invalid_body', detail: 'manifest is required' }, { status: 400 });
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestField);
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = manifestSchema.safeParse(manifestRaw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  for (const entry of parsed.data) {
    if (!isPathSafe(entry.path)) {
      return Response.json({ error: 'invalid_body', detail: `bad path: ${entry.path}` }, { status: 400 });
    }
  }

  // Parents before children -- a STABLE sort, so siblings keep the
  // manifest's own relative order. `applyBatch` never reorders its input
  // (write.ts); this is the one place ordering is decided.
  const sorted = [...parsed.data]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => depthOf(a.entry.path) - depthOf(b.entry.path) || a.index - b.index)
    .map(({ entry }) => entry);

  // One File part per add/replace entry, looked up by its own path. Read
  // only as far as `.size` for now -- the actual bytes are pulled into
  // memory below, and only once the plan is known to fit.
  const files = new Map<string, File>();
  for (const entry of sorted) {
    if (entry.op === 'mkdir') continue;
    const file = form.get(entry.path);
    if (!(file instanceof File)) {
      return Response.json(
        { error: 'invalid_body', detail: `missing file part for "${entry.path}"` },
        { status: 400 },
      );
    }
    files.set(entry.path, file);
  }

  // The same entitlement boundary every disk route uses: 404, never 403,
  // so the response cannot confirm the id is real for another org.
  const rows = await getDb()
    .select({ sha256: disks.sha256 })
    .from(disks)
    .innerJoin(entitlements, and(
      eq(entitlements.sha256, disks.sha256),
      eq(entitlements.orgId, orgId),
    ))
    .where(and(eq(disks.id, id), eq(disks.orgId, orgId)))
    .limit(1);

  const disk = rows[0];
  if (!disk) return Response.json({ error: 'not_found' }, { status: 404 });

  let adf: Uint8Array;
  try {
    adf = await diskStore.read(disk.sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }

  const volume = readVolume(adf);
  if (!volume.ok) return Response.json({ error: 'no_filesystem' }, { status: 404 });

  const usage = readUsage(adf);
  if (!usage) return Response.json({ error: 'bitmap_untrusted' }, { status: 422 });

  // §3.1: a byte total lies about whether a folder fits -- costed in
  // BLOCKS against the filesystem this disk actually uses, exactly like
  // the staging area does client-side, so the two never disagree.
  const items: CostItem[] = sorted.map((entry) => (entry.op === 'mkdir'
    ? { kind: 'dir', sizeBytes: 0 }
    : { kind: 'file', sizeBytes: files.get(entry.path)!.size }));

  const blocksNeeded = blocksForPlan(items, volume.volume.filesystem);
  if (blocksNeeded > usage.freeBlocks) {
    // Both numbers, so a refusal says exactly how far short it fell rather
    // than just that it fell short -- this IS the refusal that never
    // started (design §5): applyDiskEdit is never reached.
    return Response.json({
      error: 'edit_failed',
      reason: 'disk-full',
      blocksNeeded,
      freeBlocks: usage.freeBlocks,
    }, { status: 400 });
  }

  const ops: BatchOp[] = [];
  for (const entry of sorted) {
    const { parentPath, name } = splitPath(entry.path);
    if (entry.op === 'mkdir') {
      ops.push({ op: 'mkdir', parentPath, name });
    } else {
      const bytes = new Uint8Array(await files.get(entry.path)!.arrayBuffer());
      ops.push({ op: entry.op, parentPath, name, bytes, protection: entry.protection });
    }
  }

  const result = await applyDiskEdit(orgId, id, applyBatch(ops));
  if (!result.ok) {
    return Response.json({ error: 'edit_failed', reason: result.reason }, { status: result.status });
  }
  return Response.json({ id, sha256: result.sha256 });
}
