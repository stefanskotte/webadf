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
  // The outcome in words, kept after the toast is gone (a live region reads it out).
  const [result, setResult] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (busy) return;
    setResult('');
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
        setResult(`Could not reach the server. ${file.name} was not imported.`);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const why = body.error === 'not_sqlite'
          ? 'That is not a SQLite database — expected Amiga.sqlite.'
          : `${file.name} was rejected (${body.error ?? res.status}).`;
        toast.error('Import failed', { description: why });
        setResult(`Import failed. ${why}`);
        return;
      }
      toast.success(`Imported ${body.games} games`, {
        description: `${body.sha1s} disk hashes, sync version ${body.version ?? '?'}. Press Run now to enrich.`,
      });
      setResult(`Imported ${body.games} games, ${body.sha1s} disk hashes, sync version ${body.version ?? '?'}. Press Run now to enrich.`);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <input
        ref={input}
        type="file"
        accept=".sqlite"
        aria-hidden="true"
        onChange={onChange}
        data-testid="openretro-upload"
        className="sr-only"
        tabIndex={-1}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-testid="openretro-choose" aria-disabled={busy || undefined}
                onClick={() => { if (!busy) input.current?.click(); }}
                className="h-10 max-sm:min-h-11 rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[14px] font-medium text-(--ink) hover:bg-(--track) aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
          {busy ? 'Importing…' : 'Choose Amiga.sqlite'}
        </button>
        <span role="status" data-testid="openretro-status" className="text-[13px]" style={{ color: 'var(--muted)' }}>
          {busy ? 'Importing — a full Amiga.sqlite takes about a minute…' : result}
        </span>
      </div>
    </div>
  );
}
