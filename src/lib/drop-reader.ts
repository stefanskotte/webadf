// Reads what a drag-and-drop actually contains, before Task 8 stages it onto
// a disk. Two browser quirks make this its own module rather than a few
// inline lines:
//
//  1. FileSystemDirectoryReader.readEntries() hands back AT MOST 100 entries
//     per call and must be called again -- and again -- until it returns an
//     empty array. One call silently truncates a 250-file folder at exactly
//     100 items: no error, no warning, just a quietly wrong result.
//  2. DataTransferItem.webkitGetAsEntry() only works synchronously, inside
//     the drop handler, before any `await`. The browser neuters the
//     DataTransfer once the handler yields, so every entry must be grabbed
//     up front and only then walked asynchronously.

export interface DroppedItem {
  path: string;
  kind: 'file' | 'dir';
  file?: File;
  sizeBytes: number;
}

/**
 * Walks everything a drop contains -- files and directories, arbitrarily
 * nested -- and returns one DroppedItem per entry, files and directories
 * alike. `path` is `/`-joined and relative to the drop itself. Empty
 * directories are included: someone who drags a folder structure onto a
 * disk expects the structure, not just the files inside it.
 */
export async function readDroppedItems(items: DataTransferItemList): Promise<DroppedItem[]> {
  // Grab every entry synchronously -- no await above this line -- before the
  // DataTransfer goes away.
  const roots: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry();
    if (entry) roots.push(entry);
  }

  const out: DroppedItem[] = [];
  await Promise.all(roots.map((entry) => walk(entry, entry.name, out)));
  return out;
}

async function walk(entry: FileSystemEntry, path: string, out: DroppedItem[]): Promise<void> {
  if (entry.isDirectory) {
    out.push({ path, kind: 'dir', sizeBytes: 0 });
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    await Promise.all(children.map((child) => walk(child, `${path}/${child.name}`, out)));
    return;
  }

  const file = await new Promise<File>((resolve, reject) => {
    (entry as FileSystemFileEntry).file(resolve, reject);
  });
  out.push({ path, kind: 'file', file, sizeBytes: file.size });
}

/**
 * Pages through a directory's entries until readEntries() reports it has
 * none left. Calling it only once is the trap: it is a valid, well-formed
 * call that returns a valid, well-formed, WRONG answer once a directory
 * holds more than 100 entries.
 */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const page = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (page.length === 0) break;
    all.push(...page);
  }
  return all;
}
