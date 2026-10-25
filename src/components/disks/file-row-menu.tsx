'use client';
// A disk file row's ⋯ menu (C4 spec §5.3; board ModernDiskFiles `role=menu`). C1's title-menu pattern: the press
// never reaches dnd-kit, focus returns to the trigger unless an item opened an inline form (which takes focus itself).
import { useRef } from 'react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_ITEM } from '@/components/ui/menu-item-look';
import type { AdfEntry } from '@/lib/adffs';
import type { EditDisabled } from './file-actions';

const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };
const STOP_ALL = { onPointerDown: stop, onMouseDown: stop, onTouchStart: stop, onClick: stop } as const;

export function FileRowMenu({ entry, diskId, editDisabled, canSend, sendBusy, onSend, onRename, onMove, onProtect, onDelete }: {
  entry: AdfEntry; diskId: string; editDisabled: EditDisabled | null; canSend: boolean; sendBusy: boolean;
  onSend(): void; onRename(): void; onMove(): void; onProtect(): void; onDelete(): void;
}) {
  // Read by the popup's finalFocus as it closes, before React re-renders: an item that opens a form takes focus itself.
  const opening = useRef(false);
  const historical = editDisabled?.reason === 'historical';
  const edit = (fn: () => void) => () => { opening.current = true; fn(); };
  const why = editDisabled?.message;
  return (
    // `contents`: no box of its own. It catches what bubbles out of the menu's portalled parts that are not the popup.
    <span className="contents" {...STOP_ALL}>
      <DropdownMenu onOpenChange={(open) => { if (open) opening.current = false; }}>
        <DropdownMenuTrigger
          data-testid={`fs-more-${entry.block}`}
          aria-label={`Actions for ${entry.name}`}
          onPointerDown={stop} onMouseDown={stop} onTouchStart={stop}
          className="grid h-11 w-11 place-items-center rounded-[8px] hover:bg-[var(--track)] data-popup-open:bg-[var(--track)] sm:h-8 sm:w-8"
          style={{ color: 'var(--muted)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="fs-row-menu" finalFocus={() => !opening.current}
                             className="w-[200px] max-w-[calc(100vw-2rem)] rounded-xl p-1.5 ring-0"
                             style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)',
                                      boxShadow: '0 20px 40px -12px rgb(36 33 27 / 0.3)' }} {...STOP_ALL}>
          {entry.kind === 'file' && (historical ? (
            <DropdownMenuItem disabled title={why} data-testid={`fs-download-${entry.block}`} className={MENU_ITEM}>Download</DropdownMenuItem>
          ) : (
            <DropdownMenuItem data-testid={`fs-download-${entry.block}`} className={MENU_ITEM}
                              render={<a href={`/api/disks/${diskId}/files/${entry.block}`} />}>Download</DropdownMenuItem>
          ))}
          {canSend && (
            <DropdownMenuItem data-testid={`fs-send-${entry.block}`} disabled={sendBusy || historical}
                              title={historical ? why : undefined} aria-label={`Send ${entry.name} to the Amiga`}
                              onClick={onSend} className={MENU_ITEM}>Send to Amiga</DropdownMenuItem>
          )}
          <DropdownMenuItem data-testid={`fs-rename-${entry.block}`} disabled={!!editDisabled} title={why}
                            onClick={edit(onRename)} className={MENU_ITEM}>Rename</DropdownMenuItem>
          <DropdownMenuItem data-testid={`fs-move-${entry.block}`} disabled={!!editDisabled} title={why}
                            onClick={edit(onMove)} className={MENU_ITEM}>Move to…</DropdownMenuItem>
          <DropdownMenuItem data-testid={`fs-protect-item-${entry.block}`} disabled={!!editDisabled} title={why}
                            onClick={edit(onProtect)} className={MENU_ITEM}>Protection bits…</DropdownMenuItem>
          <DropdownMenuSeparator className="mx-1.5 my-1" style={{ background: 'var(--line)' }} />
          <DropdownMenuItem data-testid={`fs-delete-${entry.block}`} variant="destructive" disabled={!!editDisabled}
                            title={why} onClick={edit(onDelete)} className={MENU_ITEM}
                            style={{ color: 'var(--danger-fg)' }}>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
