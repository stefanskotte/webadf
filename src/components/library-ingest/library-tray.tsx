'use client';
import Link from 'next/link';
import { XIcon } from 'lucide-react';
import { SetSuggestion } from '@/components/ingest/set-suggestion';
import { traySummary, trayState } from '@/lib/library-ingest/tray';
import { useLibraryIngestContext } from './library-ingest-provider';

const TONE = {
  busy: 'var(--muted)',
  wait: 'var(--muted-2)',
  done: 'var(--success-fg)',
  fail: 'var(--danger-fg)',
} as const;

/**
 * What this visit's drops did (Files increment 3, R9): fixed to the bottom of the Library's content column, newest
 * drop first -- each disk's name, its state (Hashing… / Uploading… / Added / Already in the library / Refused and
 * why), Open title once it has one; the summary line, the set suggestion panel, and Close, which empties it (not while
 * anything is still running). Not stored: it is gone on the next visit, as the Upload card's rows were. Below `lg` it
 * sits above the bottom tab bar.
 */
export function LibraryTray() {
  const { rows, notes, busy, suggestion, clearSuggestion, close } = useLibraryIngestContext();
  if (rows.length === 0 && notes.length === 0 && !suggestion) return null;
  const summary = traySummary(rows) || 'Nothing added';

  return (
    <section data-testid="library-tray" role="region" aria-label="Adding disks"
             className="glass-card sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 mt-4 flex flex-col gap-2 rounded-2xl border p-3 shadow-lg lg:bottom-4"
             style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
      <div className="flex items-center gap-2">
        <p data-testid="library-tray-summary" role="status" aria-live="polite" className="min-w-0 flex-1 text-[13.5px] font-semibold">
          {summary}
        </p>
        <button type="button" data-testid="library-tray-close" onClick={close} disabled={busy}
                aria-label="Close" title={busy ? 'Wait for the disks being added' : 'Close'}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] hover:bg-[var(--track)] disabled:opacity-45 sm:h-8 sm:w-8"
                style={{ color: 'var(--muted)' }}>
          <XIcon className="size-4" aria-hidden />
        </button>
      </div>
      {notes.map((n) => (
        <p key={n.key} data-testid="library-tray-note" className="text-[12px]" style={{ color: 'var(--muted)' }}>{n.text}</p>
      ))}
      {rows.length > 0 && (
        <ul className="flex max-h-[32vh] flex-col overflow-y-auto border-t" style={{ borderColor: 'var(--line)' }}>
          {rows.map((r) => {
            const s = trayState(r);
            const sha = r.key.slice('lib:'.length);
            const landed = r.state === 'done' || r.state === 'deduped';
            return (
              <li key={r.key} data-testid="library-tray-row" data-key={r.key} data-state={r.state}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 border-b py-1.5 text-[13px] last:border-b-0"
                  style={{ borderColor: 'var(--line)' }}>
                <span className="min-w-0 flex-1 basis-[140px] truncate font-medium" title={r.name}>{r.name}</span>
                <span data-testid="library-tray-state" className="min-w-0 text-[12.5px]" style={{ color: TONE[s.tone] }}>
                  {s.word}
                  {r.state !== 'failed' && r.note && <span style={{ color: 'var(--muted-2)' }}> · {r.note}</span>}
                </span>
                {landed && r.title && (
                  <Link href={`/games/${r.title.gameId}`} data-testid={`library-tray-open-${sha}`}
                        aria-label={`Open title: ${r.title.title}`}
                        className="inline-flex h-11 shrink-0 items-center rounded-[8px] px-2 text-[12.5px] font-semibold underline-offset-2 hover:underline sm:h-7"
                        style={{ color: 'var(--accent-blue)' }}>
                    Open title
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {suggestion && <SetSuggestion suggestion={suggestion} onDone={clearSuggestion} />}
    </section>
  );
}
