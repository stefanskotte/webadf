'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { HelpTip } from '@/components/help/help-tip';
import { MAX_COVER_BYTES, COVER_TYPES } from '@/lib/cover-image';

/**
 * "Change image…" and "Revert to default" for a title's cover.
 *
 * Its own row under Edit details, not inside GameFacts: GameFacts renders
 * nothing for a title nobody has enriched -- precisely the utilities and
 * home-made disks that most need a picture of their own.
 *
 * Revert is offered only while the title has its own image; with none, there
 * is nothing to revert, and a button that does nothing reads as broken.
 *
 * The size check here is a courtesy (an instant message instead of an upload
 * that is then refused); the server checks everything again from the bytes.
 */
export function CoverControl({ gameId, hasOverride }: { gameId: string; hasOverride: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (file.size > MAX_COVER_BYTES) {
      toast.error('Images can be at most 2 MB');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(gameId)}/cover`, { method: 'PUT', body: file });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.detail ?? 'Could not use that image');
        return;
      }
      toast.success('Cover image changed');
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
      // Picking the same file again must fire change again.
      if (input.current) input.current.value = '';
    }
  }

  async function revert() {
    setBusy(true);
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(gameId)}/cover`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Could not revert the cover image');
        return;
      }
      toast.success('Cover image reverted to the default');
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const buttonClass = 'shrink-0 rounded-full border px-3 py-1 text-[12.5px] font-semibold disabled:opacity-60';
  const buttonStyle = { borderColor: 'rgb(255 255 255 / 0.22)', color: 'var(--on-dark-muted)' };

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-7" style={{ color: 'var(--on-dark-muted)' }}>
      <input
        ref={input}
        type="file"
        accept={COVER_TYPES.join(',')}
        className="hidden"
        data-testid="cover-file"
        aria-label="Choose a cover image"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
      />
      <button type="button" data-testid="cover-change" disabled={busy}
              onClick={() => input.current?.click()} className={buttonClass} style={buttonStyle}>
        {busy ? 'Working…' : 'Change image…'}
      </button>
      {hasOverride && (
        <button type="button" data-testid="cover-revert" disabled={busy}
                onClick={() => void revert()} className={buttonClass} style={buttonStyle}>
          Revert to default
        </button>
      )}
      <HelpTip topic="cover-image" />
    </div>
  );
}
