'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Mirrors DatUpload, with two deliberate differences: a SINGLE file, because
 * there is only ever one Amiga.sqlite, and a BINARY body -- the route reads
 * request.arrayBuffer(), not text(), so a 29 MB database is posted as-is
 * rather than being mangled through a text decode.
 */
export function OpenRetroUpload() {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      let res: Response;
      try {
        res = await fetch('/api/admin/openretro', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        });
      } catch {
        toast.error('Could not reach the server', { description: file.name });
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error('Import failed', {
          description: body.error === 'not_sqlite'
            ? 'That is not a SQLite database — expected Amiga.sqlite.'
            : `${file.name} was rejected (${body.error ?? res.status}).`,
        });
        return;
      }
      toast.success(`Imported ${body.games} games`, {
        description: `${body.sha1s} disk hashes, sync version ${body.version ?? '?'}. Press Run now to enrich.`,
      });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="openretro-file" className="text-[12.5px] font-semibold">
        Import OpenRetro metadata
      </label>
      <input
        id="openretro-file"
        ref={input}
        type="file"
        accept=".sqlite"
        disabled={busy}
        onChange={onChange}
        data-testid="openretro-upload"
        className="text-[13px]"
      />
      <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
        {busy
          ? 'Importing — a full Amiga.sqlite takes about a minute…'
          : 'Select the Amiga.sqlite that FS-UAE Launcher syncs. Re-importing a newer sync updates entries in place.'}
      </span>
    </div>
  );
}
