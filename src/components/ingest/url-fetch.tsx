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
    <form onSubmit={submit} className="glass-card flex flex-col gap-2 p-4" data-testid="url-fetch-form" noValidate>
      <label htmlFor="ingest-url" className="text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>
        Or fetch from a URL
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="ingest-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://…/Game.adf"
          data-testid="url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          aria-describedby="ingest-url-hint ingest-url-status"
          className="h-11 min-w-0 flex-1 rounded-[10px] border px-3 text-[13px] outline-none focus-visible:ring-2 sm:h-[34px]"
          style={{ borderColor: 'var(--hairline-strong)', background: 'var(--glass)', color: 'var(--ink)' }}
        />
        <button
          type="submit"
          data-testid="url-fetch"
          disabled={busy || url.trim() === ''}
          className="h-11 shrink-0 rounded-lg px-4 text-[13px] font-medium disabled:opacity-50 sm:h-[34px]"
          style={{ background: '#fff', border: '1px solid var(--hairline-strong)', boxShadow: 'var(--shadow-card)', color: 'var(--ink)' }}
        >
          {busy ? 'Working…' : 'Fetch'}
        </button>
      </div>
      <span id="ingest-url-hint" className="font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
        ADF, ADZ, DMS, HFE or a .zip of them, up to 20 MB, from a public http(s) address
      </span>
      <p
        id="ingest-url-status"
        role="status"
        aria-live="polite"
        data-testid="url-status"
        className="min-h-[1em] text-[12px]"
        style={{ color }}
      >
        {status?.text ?? ''}
      </p>
    </form>
  );
}
