import { expandArchive, isArchiveName, MAX_ARCHIVE_BYTES, type ArchiveResult } from './archive';
import type { DroppedItem } from './drop-reader';
import { pathTooDeep, unaddressableName } from './staging';

export { pathTooDeep };

/**
 * An archive dropped on a disk's Browse view, turned into the SAME
 * `DroppedItem[]` a dropped folder produces -- so staging, the destination,
 * collision handling, the 30-character name rule and the block-based fit check
 * apply to it without knowing it was an archive (HANDOFF 3ae).
 *
 * Lifted out of drop-staging.tsx so the mapping is testable, and tightened on
 * the way: member paths are untrusted input, so `..`/`.` segments, a nesting
 * deeper than the filesystem reader walks, and a path the archive holds twice
 * are refused here by name rather than handed to the batch route (which would
 * 400 the WHOLE batch on one bad path) or written twice.
 */

export interface ArchiveNotice {
  /** The dropped archive's own file name. */
  archive: string;
  /** The member's path inside it. */
  path: string;
  reason: string;
}

export function archiveToDroppedItems(
  archiveName: string, result: ArchiveResult,
): { items: DroppedItem[]; skipped: ArchiveNotice[] } {
  const skipped: ArchiveNotice[] = result.skipped.map((s) => ({ archive: archiveName, ...s }));

  // Normalise and vet every member first, so the duplicate rule below compares
  // the paths that would actually be written.
  const vetted: { path: string; bytes: Uint8Array; protection: number | null }[] = [];
  for (const m of result.members) {
    const parts = m.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) {
      skipped.push({ archive: archiveName, path: m.path, reason: 'unsafe path' });
      continue;
    }
    if (parts.some(unaddressableName)) {
      skipped.push({ archive: archiveName, path: m.path, reason: 'name AmigaDOS cannot hold' });
      continue;
    }
    const path = parts.join('/');
    if (pathTooDeep(path)) {
      skipped.push({ archive: archiveName, path: m.path, reason: 'nested too deep' });
      continue;
    }
    vetted.push({ path, bytes: m.bytes, protection: m.protection });
  }

  // An LHA can be appended to, so the same path can appear twice; the later
  // copy is the newer one, which is what `lha x` leaves on disk too.
  const lastIndex = new Map<string, number>();
  vetted.forEach((m, i) => lastIndex.set(m.path, i));
  const members = vetted.filter((m, i) => {
    if (lastIndex.get(m.path) === i) return true;
    skipped.push({ archive: archiveName, path: m.path, reason: 'duplicate (the later copy is used)' });
    return false;
  });

  // Parent directories, synthesised from the member paths. A dropped FOLDER
  // arrives with its directories as entries and the commit turns those into
  // mkdir ops; an archive carries its structure only in the paths, so without
  // this a nested member would be written into a directory never created.
  // Sorted, so a parent always precedes its children.
  const dirs = new Set<string>();
  for (const m of members) {
    const parts = m.path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }

  const items: DroppedItem[] = [...dirs].sort().map((d) => ({ path: d, kind: 'dir', sizeBytes: 0 }));
  for (const m of members) {
    items.push({
      path: m.path,
      kind: 'file',
      sizeBytes: m.bytes.length,
      file: new File([m.bytes as unknown as BlobPart], m.path.split('/').pop() ?? 'file'),
      protection: m.protection,
    });
  }
  return { items, skipped };
}

/**
 * Expand every archive in a drop; everything else passes through untouched,
 * which is what keeps a plain file drop exactly as it was. An archive that
 * cannot be read at all is `refused` with a message naming it -- none of it is
 * staged, so nothing of it can be written.
 */
export async function expandArchivesInDrop(dropped: readonly DroppedItem[]): Promise<{
  items: DroppedItem[];
  refused: { name: string; message: string }[];
  skipped: ArchiveNotice[];
}> {
  const items: DroppedItem[] = [];
  const refused: { name: string; message: string }[] = [];
  const skipped: ArchiveNotice[] = [];
  for (const item of dropped) {
    if (item.kind !== 'file' || !item.file || !isArchiveName(item.file.name)) {
      items.push(item);
      continue;
    }
    const name = item.file.name;
    // Judged on the File's own size before reading it into memory.
    if (item.file.size > MAX_ARCHIVE_BYTES) {
      refused.push({ name, message: `${name} is ${(item.file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.` });
      continue;
    }
    const result = await expandArchive(name, new Uint8Array(await item.file.arrayBuffer()));
    if (result === null) { items.push(item); continue; }
    if ('error' in result) {
      refused.push({
        name,
        message: result.error === 'too-large'
          ? `${name} is ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`
          : `${name} is not an .lha, .lzh or .zip this can open.`,
      });
      continue;
    }
    const mapped = archiveToDroppedItems(name, result);
    if (mapped.items.length === 0) {
      // Every member was refused: say so as a refusal, not as an empty batch.
      refused.push({ name, message: `Nothing in ${name} could be read.` });
      skipped.push(...mapped.skipped);
      continue;
    }
    items.push(...mapped.items);
    skipped.push(...mapped.skipped);
  }
  return { items, refused, skipped };
}

/** What a staged batch will write, for the review line above the Add button. */
export function stagingSummary(rows: readonly { kind: 'file' | 'dir'; sizeBytes: number }[]) {
  let files = 0; let folders = 0; let bytes = 0;
  for (const r of rows) {
    if (r.kind === 'dir') folders++;
    else { files++; bytes += r.sizeBytes; }
  }
  return { files, folders, bytes };
}
