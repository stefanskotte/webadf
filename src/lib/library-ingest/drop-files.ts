// What a Library page drop carries (Files increment 3, ruling R8): the disk images, with folders walked and .zip/.lha
// opened for the images inside, so the extracted pipeline (run.ts) sees image files only -- exactly what the Upload
// card fed it. Client-safe: the archive readers run in the tab, under their own bomb caps (src/lib/archive).

import { expandArchive, isArchiveName, MAX_ARCHIVE_BYTES } from '@/lib/archive';
import { DISK_IMAGE_PATTERN } from '@/lib/archive/disk-image';

export type DropFileItem = { name: string; file?: File; kind: 'file' | 'dir' };
export type DropRefusal = { name: string; reason: string };

const baseName = (path: string) => path.split('/').pop() ?? path;

/**
 * The disk images a drop carries (R8): image files as they are, folders walked (the items already hold a folder's
 * files, as readDroppedItems returns them; a `dir` item itself carries nothing), .zip/.lha/.lzh opened for the images
 * inside, each named by its member's base name. What was refused is named in `refused` with a reason, so a drop that
 * added nothing says why: a file that is not an image, an archive with no images or that will not open, an image the
 * archive reader would not decode. An archive that DID hold images is not refused for the other files beside them (a
 * readme in a game's .lha is the ordinary case): `notes` says, one line per archive, that they were left out. Dotfiles (.DS_Store, ._Game.adf) are a folder's
 * housekeeping, not something the person dropped: they are left out without a word, as __MACOSX/ is inside a zip.
 * Nested archives are not opened (expandArchive's rule).
 */
export async function diskFilesFromDrop(items: DropFileItem[]): Promise<{ files: File[]; refused: DropRefusal[]; notes: string[] }> {
  const files: File[] = [];
  const refused: DropRefusal[] = [];
  const notes: string[] = [];
  for (const item of items) {
    if (item.kind !== 'file' || !item.file) continue;
    const name = baseName(item.name);
    if (name.startsWith('.')) continue;
    if (DISK_IMAGE_PATTERN.test(name)) {
      files.push(item.file.name === name ? item.file : new File([item.file], name, { lastModified: item.file.lastModified }));
      continue;
    }
    if (!isArchiveName(name)) {
      refused.push({ name, reason: 'not a disk image' });
      continue;
    }
    // Refused on its size BEFORE it is read: expandArchive checks the cap too, but only on bytes already in the tab,
    // and a multi-GB zip would be read into memory first.
    if (item.file.size > MAX_ARCHIVE_BYTES) {
      refused.push({ name, reason: "can't open this archive" });
      continue;
    }
    const r = await expandArchive(name, new Uint8Array(await item.file.arrayBuffer()));
    if (!r || 'error' in r) {
      refused.push({ name, reason: "can't open this archive" });
      continue;
    }
    let images = 0;
    let others = 0;
    for (const m of r.members) {
      if (m.path.startsWith('__MACOSX/') || m.path.endsWith('/')) continue;
      const member = baseName(m.path);
      if (!member || member.startsWith('.')) continue;
      if (!DISK_IMAGE_PATTERN.test(member)) { others++; continue; }
      images++;
      files.push(new File([m.bytes as unknown as BlobPart], member, { lastModified: m.date?.getTime() ?? Date.now() }));
    }
    // An image the reader would not decode (over the per-member cap, an unknown method) is named with the reader's
    // reason; the rest of what it skipped is counted with the other files.
    for (const s of r.skipped) {
      if (s.path.startsWith('__MACOSX/') || s.path.endsWith('/')) continue;
      if (DISK_IMAGE_PATTERN.test(s.path)) refused.push({ name: `${name}: ${baseName(s.path)}`, reason: s.reason });
      else others++;
    }
    const unreadImages = r.skipped.some((s) => DISK_IMAGE_PATTERN.test(s.path));
    if (images === 0 && !unreadImages) refused.push({ name, reason: 'no disk images inside' });
    else if (others > 0) notes.push(`${name}: ${others === 1 ? '1 other file' : `${others} other files`} inside, not disk images, left out`);
  }
  return { files, refused, notes };
}
