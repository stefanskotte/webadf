'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronDownIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Make a blank Amiga disk, where you are standing.
 *
 * "Where you are standing" is literal: if the library is filtered to a
 * collection, the new disk joins that collection. The server resolves the id
 * against this org's own collections before filing anything, because
 * collection_games carries no org_id of its own (D-4-5).
 *
 * The disk is REAL as soon as this returns (operator's ruling): there is no
 * draft card. router.refresh() then brings it back from the server ordered
 * first, since the library is createdAt-descending (D9) -- the card does not
 * need to be faked into place.
 *
 * ONE control, not two. This started as a <select> sitting beside a button,
 * on the reasoning that the filesystem is one choice with two answers and
 * hiding it would make the rarer answer the harder one to give. Using it
 * showed the cost: a select KEEPS ITS VALUE, so picking OFS once silently
 * made every later disk OFS, and the pair read as two controls for one
 * action. Naming the filesystem inside each menu item gives the rare answer
 * equal billing without carrying state between clicks.
 */
export function CreateAdf() {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);

  async function create(filesystem: 'FFS' | 'OFS') {
    setBusy(true);
    try {
      const collectionId = params.get('collection');
      const res = await fetch('/api/disks/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filesystem, ...(collectionId ? { collectionId } : {}) }),
      });
      if (!res.ok) {
        toast.error('Could not create the disk');
        return;
      }
      const body = await res.json().catch(() => null);
      toast.success(`Blank ${filesystem} disk created`, {
        description: body?.collectionId ? 'Added to this collection.' : 'Name it on its card.',
      });
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="create-adf"
        disabled={busy}
        className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold disabled:opacity-50"
        style={{ background: 'var(--on-dark)', color: '#16273a' }}
      >
        {busy ? 'Creating…' : 'Create ADF'}
        <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden />
      </DropdownMenuTrigger>
      {/* align="start" because the trigger is the leftmost thing in the page
          header's actions. At 390px the popup would otherwise be anchored to
          a right edge it has no room to open from. */}
      <DropdownMenuContent
        align="start"
        style={{ background: 'var(--glass-strong)', color: 'var(--ink)', border: '1px solid var(--hairline-strong)' }}
      >
        {/* FFS first and unmarked as "default": on a menu the first item IS
            the default, so a badge saying so would only add a word to read.
            Both items name their filesystem and neither is explained here --
            anyone choosing OFS over FFS already knows which one their machine
            needs, and the menu is not the place to teach it. */}
        <DropdownMenuItem data-testid="create-adf-ffs" onClick={() => create('FFS')}>
          Create ADF (FFS)
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="create-adf-ofs" onClick={() => create('OFS')}>
          Create ADF (OFS)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
