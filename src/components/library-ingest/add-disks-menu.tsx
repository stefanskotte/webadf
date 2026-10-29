'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, FolderOpen, Link2, PlusIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_ITEM } from '@/components/ui/menu-item-look';
import { Modal } from '@/components/ui/modal';
import { UrlFetch } from '@/components/ingest/url-fetch';
import { useLibraryIngestContext } from './library-ingest-provider';

/** What Browse files… takes: the disk images the pipeline converts, and the archives drop-files.ts opens for them. */
const ACCEPT = '.adf,.dsk,.adz,.dms,.dmz,.hfe,.zip,.lha,.lzh';

/**
 * "＋ Add disks ▾" in the Library header (Files increment 3, mock-up part 3): Browse files… (the file picker, which
 * is how a phone adds disks: it has no OS drag), Paste a URL… (/api/ingest/url in a dialog; the server opens a .zip
 * or .lha itself) and a hint that the whole page takes a drop. What each disk did shows in the tray at the bottom.
 * `/library#add-disks` opens it on page load; the empty library's Add disks button opens it through the provider (R11).
 */
export function AddDisksMenu() {
  const ingest = useLibraryIngestContext();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // In the provider, not here: the empty library's Add disks button opens it too (a hash link would not, after a
  // soft navigation to the same page).
  const { menuOpen: open, setMenuOpen: setOpen } = ingest;
  const [urlOpen, setUrlOpen] = useState(false);

  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash !== '#add-disks') return;
      setOpen(true);
      // Said once: a reload of the page should not open the menu again.
      history.replaceState(history.state, '', window.location.pathname + window.location.search);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
    // setOpen is the provider's useState setter: stable, so this still runs once.
  }, [setOpen]);

  function picked(files: FileList | null) {
    if (!files?.length) return;
    void ingest.addItems([...files].map((file) => ({ name: file.name, kind: 'file' as const, file })));
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          ref={trigger}
          data-testid="library-add-disks"
          // The header's primary button (mock-up: the dark one), plus before and a chevron after, as Create ADF.
          className="flex h-10 max-sm:min-h-11 items-center gap-2 rounded-[10px] border px-3.5 text-[14px] font-semibold text-white disabled:opacity-50"
          style={{ background: 'var(--primary-action)', borderColor: 'var(--primary-action)' }}
        >
          <PlusIcon className="h-4 w-4" aria-hidden />
          {ingest.busy ? 'Adding…' : 'Add disks'}
          <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-testid="library-add-disks-panel"
          className="w-[248px] max-w-[calc(100vw-2rem)] rounded-xl p-1.5 ring-0"
          style={{
            background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)',
            boxShadow: '0 20px 40px -12px rgb(36 33 27 / 0.3)',
          }}
        >
          <DropdownMenuItem data-testid="library-add-browse" className={MENU_ITEM} disabled={ingest.busy}
                            onClick={() => input.current?.click()}>
            <FolderOpen aria-hidden />Browse files…
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="library-add-url" className={MENU_ITEM} disabled={ingest.busy}
                            onClick={() => setUrlOpen(true)}>
            <Link2 aria-hidden />Paste a URL…
          </DropdownMenuItem>
          <DropdownMenuItem disabled data-testid="library-add-hint"
                            className="h-auto px-2.5 py-1.5 text-[12px] data-disabled:opacity-100"
                            style={{ color: 'var(--muted-2)' }}>
            or drop disks anywhere on this page
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Outside the popup, which unmounts as an item is picked. */}
      <input ref={input} type="file" multiple accept={ACCEPT} aria-label="Browse files" className="sr-only" tabIndex={-1}
             data-testid="file-input" disabled={ingest.busy}
             onChange={(e) => { picked(e.target.files); e.target.value = ''; }} />
      <Modal open={urlOpen} onOpenChange={setUrlOpen} title="Add disks from a URL" width={440}
             subtitle="The server downloads the file and adds the disks in it; what each one did shows at the bottom of the Library."
             testId="library-add-url-dialog" closeTestId="library-add-url-close" dismissible={!ingest.busy}
             finalFocus={trigger}
             footer={
               <button type="button" data-testid="library-add-url-done" disabled={ingest.busy} onClick={() => setUrlOpen(false)}
                       className="ml-auto h-9 rounded-[10px] border px-4 text-[13px] font-semibold disabled:opacity-50"
                       style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
                 Done
               </button>
             }>
        <div className="flex flex-col gap-2 px-6 py-5">
          <UrlFetch busy={ingest.busy} setBusy={ingest.setBusy} onRows={ingest.addFetched} />
        </div>
      </Modal>
    </>
  );
}
