'use client';

// A disk row's ⋯ menu when the row is one of a disk set (mockup view 1).
// Its own module, not part of disk-set-section.tsx, so disk-row.tsx can import
// it without a cycle (the section renders DiskRow).

import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_ITEM_HIGHLIGHT } from '@/components/ui/menu-item-look';
import { AddDisksDialog } from './add-disks-dialog';

export interface DiskSetControls {
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onMoveOut: () => void;
}

// The drive-chip menu's item look (drive-chips.tsx ITEM_CLASS), with a 44px
// row below `sm` so a finger can hit it.
const ITEM_CLASS =
  `min-h-11 px-2 py-1 text-[13px] sm:min-h-8 ${MENU_ITEM_HIGHLIGHT}`;

// The 38 px ghost look the other icon buttons on the row wear (44 px below `sm`).
const TRIGGER_CLASS = 'grid h-11 w-11 shrink-0 place-items-center rounded-[10px] transition-colors hover:bg-[var(--surface-2)] sm:h-[38px] sm:w-[38px]';
const TRIGGER_STYLE = { color: 'var(--ink)' };
// The panel matches the title menu (spec §2): surface, line border, 12 px radius.
const CONTENT_CLASS = 'w-48 max-w-[calc(100vw-2rem)] rounded-[12px]';
const CONTENT_STYLE = { background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-modal)' };

export function DiskSetMenu({ diskId, name, controls }: {
  diskId: string;
  name: string;
  controls: DiskSetControls;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={`disk-menu-${diskId}`}
        aria-label={`Disk set actions for ${name}`}
        className={TRIGGER_CLASS}
        style={TRIGGER_STYLE}
      >
        <MoreHorizontal size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={CONTENT_CLASS}
        style={CONTENT_STYLE}
      >
        <DropdownMenuItem data-testid={`disk-up-${diskId}`} className={ITEM_CLASS}
                          disabled={!controls.canUp} onClick={controls.onUp}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem data-testid={`disk-down-${diskId}`} className={ITEM_CLASS}
                          disabled={!controls.canDown} onClick={controls.onDown}>
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1" style={{ background: 'var(--line)' }} />
        <DropdownMenuItem data-testid={`disk-move-out-${diskId}`} className={ITEM_CLASS}
                          onClick={controls.onMoveOut}>
          Move out of set
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A lone disk's ⋯ menu (mockup view 4): a one-disk title is not a set, so its
 * only set action is joining one. Owns the dialog in 'target' mode; after the
 * move the dialog takes the page to the set.
 */
export function LoneDiskMenu({ diskId, gameId, name }: {
  diskId: string;
  /** The disk's own title, left out of the candidates. */
  gameId: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`disk-menu-${diskId}`}
          aria-label={`Disk set actions for ${name}`}
          className={TRIGGER_CLASS}
          style={TRIGGER_STYLE}
        >
          <MoreHorizontal size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={CONTENT_CLASS} style={CONTENT_STYLE}>
          <DropdownMenuItem data-testid={`disk-add-to-set-${diskId}`} className={ITEM_CLASS}
                            onClick={() => setOpen(true)}>
            Add to a disk set…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && (
        <AddDisksDialog mode={{ kind: 'target', gameId, diskId }} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
