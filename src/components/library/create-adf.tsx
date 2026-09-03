'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

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
 */
export function CreateAdf() {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [filesystem, setFilesystem] = useState<'FFS' | 'OFS'>('FFS');

  async function create() {
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
    <div className="flex items-center gap-2">
      {/* The filesystem sits BESIDE the button rather than behind a dialog:
          it is one choice with two answers, and FFS is right for almost every
          disk. Hiding it would make the rarer, hardware-specific answer the
          harder one to give. */}
      <label className="sr-only" htmlFor="create-adf-fs">Filesystem for the new disk</label>
      <select
        id="create-adf-fs"
        data-testid="create-adf-fs"
        value={filesystem}
        disabled={busy}
        onChange={(e) => setFilesystem(e.target.value === 'OFS' ? 'OFS' : 'FFS')}
        className="h-8 rounded-lg border px-2 text-[12px] font-semibold"
        style={{ borderColor: 'rgb(255 255 255 / 0.22)', background: 'rgb(255 255 255 / 0.12)', color: 'var(--on-dark)' }}
      >
        <option value="FFS">FFS</option>
        <option value="OFS">OFS</option>
      </select>
      <button
        type="button"
        data-testid="create-adf"
        disabled={busy}
        onClick={create}
        className="h-8 rounded-full px-3 text-[12.5px] font-semibold disabled:opacity-50"
        style={{ background: 'var(--on-dark)', color: '#16273a' }}
      >
        {busy ? 'Creating…' : 'Create ADF'}
      </button>
    </div>
  );
}
