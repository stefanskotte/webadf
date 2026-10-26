'use client';
import { useState } from 'react';
import { describeUrlRefusal } from '@/lib/url-ingest-messages';

/** One row as /api/ingest/url returns it; the dropzone renders it like a dropped file's. */
export type FetchedRow = {
  filename: string;
  sizeBytes: number;
  sha256: string | null;
  state: 'deduped' | 'done' | 'failed';
  note?: string;
  title?: { gameId: string; title: string } | null;
};

/**
 * "Or fetch from a URL": the server downloads the file and ingests it exactly
 * like a browser upload (src/lib/url-ingest.ts). The result rows go into the
 * dropzone's own table via onRows.
 */
export function UrlFetch({
  busy, setBusy, onRows,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onRows: (rows: FetchedRow[], since: string) => Promise<void> | void;
}) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<{ text: string; tone: 'muted' | 'danger' | 'ok' } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = url.trim();
    if (!value || busy) return;
    const since = new Date().toISOString();
    setBusy(true);
    setStatus({ text: 'Fetching… the server is downloading and checking the file.', tone: 'muted' });
    try {
      const res = await fetch('/api/ingest/url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: value }),
      });
      let data: { rows?: FetchedRow[]; error?: string; status?: number; retryAfter?: number } = {};
      try { data = await res.json(); } catch { /* not JSON: handled as a plain failure */ }
      if (!res.ok || !data.rows) {
        setStatus({ text: describeUrlRefusal(data.error ?? '', data.status, data.retryAfter), tone: 'danger' });
        return;
      }
      const landed = data.rows.filter((r) => r.state !== 'failed').length;
      const failed = data.rows.length - landed;
      setStatus({
        text: `Fetched: ${landed} disk${landed === 1 ? '' : 's'} added${failed ? `, ${failed} refused` : ''}.`,
        tone: failed && !landed ? 'danger' : 'ok',
      });
      if (landed) setUrl('');
      await onRows(data.rows, since);
    } catch {
      setStatus({ text: describeUrlRefusal(''), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const color = status?.tone === 'danger' ? 'var(--danger-fg)' : status?.tone === 'ok' ? 'var(--success-fg)' : 'var(--muted-2)';

  return (
    <>
      <form onSubmit={submit} data-testid="url-fetch-form" noValidate
            className="flex h-[46px] w-full min-w-0 items-center max-sm:order-2 max-sm:col-span-2 gap-1.5 rounded-[10px] border px-2.5 sm:h-[38px] sm:w-auto sm:min-w-[220px] sm:flex-1"
            style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
        <input
          id="ingest-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="or paste a URL…"
          aria-label="Or fetch from a URL"
          data-testid="url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          aria-describedby="ingest-url-hint ingest-url-status"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-[var(--muted-2)]"
          style={{ color: 'var(--ink)' }}
        />
        <button
          type="submit"
          data-testid="url-fetch"
          disabled={busy || url.trim() === ''}
          className="h-11 shrink-0 rounded-[8px] border px-2.5 text-[12px] font-semibold disabled:opacity-50 sm:h-7"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
        >
          {busy ? 'Working…' : 'Fetch'}
        </button>
      </form>
      <span id="ingest-url-hint" className="basis-full text-[12px] max-sm:order-2 max-sm:col-span-2" style={{ color: 'var(--muted-2)' }}>
        A URL can also be a .zip or .lha of them, up to 20 MB, from a public http(s) address.
      </span>
      <p
        id="ingest-url-status"
        role="status"
        aria-live="polite"
        data-testid="url-status"
        className="min-h-[1em] basis-full text-[12px] max-sm:order-2 max-sm:col-span-2"
        style={{ color }}
      >
        {status?.text ?? ''}
      </p>
    </>
  );
}
