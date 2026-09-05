import type { Page } from '@playwright/test';

/**
 * One node of a fake dropped tree -- a file with content, or a directory
 * with children. Mirrors `DroppedItem`'s shape closely enough for
 * `readDroppedItems` (src/lib/drop-reader.ts) to walk it exactly as it
 * would walk a real one, but expressed as plain, JSON-serialisable data so
 * it can cross the `page.evaluate` boundary -- functions cannot.
 */
export interface DropNode {
  name: string;
  kind: 'file' | 'dir';
  /** Only meaningful for a file. Defaults to '' (an empty file). */
  content?: string;
  /** Only meaningful for a directory. Defaults to no children. */
  children?: DropNode[];
}

/**
 * Synthesizes an OS-style file drop onto `[data-testid="drop-strip"]`.
 *
 * WHY THIS EXISTS: Playwright cannot perform a real HTML5 file drop from
 * the operating system -- there is no API, in any browser, for test
 * automation to hand a page a `DataTransfer` backed by real files the way
 * a person dragging a Finder/Explorer window does. The two ways around
 * that are driving a real `<input type="file">` (not available here --
 * the drop strip is a bare `onDrop` target, not a file input) or building
 * a fake `DataTransfer` in the page and dispatching it, which is what this
 * does.
 *
 * HOW: a plain, cancelable `Event` named "drop" -- not `new DragEvent(...)`,
 * which no browser lets a script construct with a real DataTransfer full of
 * file entries attached, for exactly the security reason a real OS drop
 * cannot be automated either. A `dataTransfer` property is attached to that
 * plain Event by hand. That is sufficient for `drop-staging.tsx`'s own
 * `handleDrop`, whose React `onDrop` prop reads `event.dataTransfer` off
 * the NATIVE event it was given -- React's synthetic event system copies
 * `dataTransfer` straight from `nativeEvent.dataTransfer` for a "drop"
 * event (react-dom's `DragEventInterface`), with no check that the native
 * event is a genuine `DragEvent` instance.
 *
 * `items[].webkitGetAsEntry()` returns fake `FileSystemEntry`-like objects
 * built from `tree` -- `isDirectory`/`isFile`, `file(success)`, and for a
 * directory a `createReader().readEntries(success)` that pages its
 * children in chunks of AT MOST 100, exactly like the real
 * `FileSystemDirectoryReader` contract (design doc §3.4). A caller of
 * `readDroppedItems` that forgot to loop `readEntries` until it returns an
 * empty array would truncate at 100 items here exactly as it would against
 * a real folder -- which is what makes the "doesn't fit" test in
 * disk-drag-drop.spec.ts a real check of the paging loop, not just of the
 * capacity arithmetic: break the paging and that test's numbers stop
 * matching what it expects, because only the first 100 (of however many
 * more were staged) would ever be read.
 *
 * WHAT THIS DOES NOT PROVE: `webkitGetAsEntry()` itself is never exercised
 * -- these fake entries skip the browser's own File System Access
 * plumbing entirely (there is no real OS file system underneath any of
 * this), so a browser-specific bug in that API's real implementation, or
 * in how a specific OS/browser combination populates
 * `DataTransferItemList` for a genuine external drop, would not be caught
 * by any test built on this helper.
 */
export async function synthDrop(page: Page, tree: DropNode[]): Promise<void> {
  await page.evaluate((treeArg: DropNode[]) => {
    function makeEntry(node: DropNode): unknown {
      if (node.kind === 'dir') {
        const children = (node.children ?? []).map(makeEntry);
        let index = 0;
        return {
          isDirectory: true,
          isFile: false,
          name: node.name,
          createReader() {
            return {
              readEntries(success: (entries: unknown[]) => void) {
                const chunk = children.slice(index, index + 100);
                index += chunk.length;
                success(chunk);
              },
            };
          },
        };
      }
      return {
        isDirectory: false,
        isFile: true,
        name: node.name,
        file(success: (f: File) => void) {
          success(new File([node.content ?? ''], node.name));
        },
      };
    }

    const items = treeArg.map((node) => ({
      kind: 'file',
      webkitGetAsEntry: () => makeEntry(node),
    }));

    const dropZone = document.querySelector('[data-testid="drop-strip"]');
    if (!dropZone) throw new Error('synthDrop: [data-testid="drop-strip"] not found on the page');

    const evt = new Event('drop', { bubbles: true, cancelable: true });
    (evt as unknown as { dataTransfer: unknown }).dataTransfer = { items, files: [] };
    dropZone.dispatchEvent(evt);
  }, tree);
}

/** A directory holding `count` zero-byte files -- the shape that makes a byte total lie about block cost (design §3.1): each costs a header block plus one data block regardless of how tiny it is, so `count` files costs `2 * count` blocks for zero bytes of actual content. Also, at `count` > 100, a folder `readDroppedItems` can only see correctly if it pages through `readEntries` rather than trusting a single call. */
export function manyEmptyFilesTree(dirName: string, count: number): DropNode[] {
  return [{
    name: dirName,
    kind: 'dir',
    children: Array.from({ length: count }, (_, i) => ({
      name: `F${i}.BIN`,
      kind: 'file' as const,
      content: '',
    })),
  }];
}
