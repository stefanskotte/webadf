'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Candidate, type ProductionLite } from './demozoo-actions';
import { appliedMessage, MIN_QUERY_LEN, queryTooShort, resultsAnnouncement, tosecApplyBody } from './identify-search-logic';

// Redeclared, not imported: @/lib/tosec-search pulls the database into the
// browser bundle (the same reason demozoo-actions.tsx redeclares its types).
export interface TosecReleaseLite {
  key: string; name: string; title: string; year: number | null; publisher: string | null; diskCount: number;
}

type Sources = 'all' | 'tosec';

const TAG = 'mb-0.5 mr-2 inline-block rounded-full px-2 py-px align-middle text-[10.5px] font-semibold uppercase tracking-wide';

function Tag({ source }: { source: 'demozoo' | 'tosec' }) {
  return (
    <span data-testid={`identify-search-result-${source}`} className={TAG}
      style={{ background: 'var(--hairline)', color: 'var(--muted)' }}>
      {source === 'demozoo' ? 'Demozoo' : 'TOSEC'}
    </span>
  );
}

const disks = (n: number) => `${n} ${n === 1 ? 'disk' : 'disks'}`;

/**
 * A TOSEC release. "Use these details" is an ordinary identity edit through
 * PATCH /api/games/[id] -- exactly what typing them into the edit form would
 * do, so the title is stamped 'human' and no later scan overwrites it. It
 * replaces the identity as a whole: a year or publisher TOSEC does not know
 * is sent as null and cleared, not left over from whatever the title was.
 *
 * `applying` is owned by the list, not the row: while any row's PATCH is in
 * flight every row's button is disabled, so two releases cannot race to be
 * the title's identity.
 */
function TosecRow({ gameId, r, applying, onApplying }: {
  gameId: string; r: TosecReleaseLite; applying: boolean; onApplying: (busy: boolean) => void;
}) {
  const router = useRouter();

  async function use() {
    onApplying(true);
    try {
      const res = await fetch(`/api/games/${gameId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tosecApplyBody(r)),
      });
      if (!res.ok) { toast.error('Could not set the details'); return; }
      const msg = appliedMessage(await res.json().catch(() => null));
      if (msg.kind === 'info') toast.info(msg.text); else toast.success(msg.text);
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      onApplying(false);
    }
  }

  return (
    <li data-testid="tosec-search-result" data-key={r.key}
        className="flex flex-col gap-2.5 rounded-[10px] p-2.5" style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
      <div className="min-w-0 flex-1">
        <Tag source="tosec" />
        <span className="break-words font-semibold">{r.name}</span>
        <div className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
          {[r.year, r.publisher, disks(r.diskCount)].filter(Boolean).join(' · ')}
        </div>
      </div>
      <button type="button" data-testid={`tosec-use-${r.key}`} disabled={applying} onClick={use}
        aria-label={`Use these details: ${r.name}`}
        className="min-h-11 w-fit shrink-0 rounded-[10px] px-3.5 text-[13px] font-semibold text-white disabled:opacity-50 sm:h-[38px] sm:min-h-0"
        style={{ background: 'var(--primary-action)' }}>
        Use these details
      </button>
    </li>
  );
}

/**
 * The title page's one search box over both local catalogs. `sources="tosec"`
 * is for a title the scans know is a game: Demozoo is never offered for a
 * game (Demozoo spec §5.3.1), and the server is asked not to search it at all.
 *
 * The form and input keep their original demozoo-search test ids: this box
 * replaced "Find on Demozoo" in place.
 */
export function IdentifySearch({ gameId, sources }: { gameId: string; sources: Sources }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ demozoo: ProductionLite[]; tosec: TosecReleaseLite[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [tooShort, setTooShort] = useState(false);
  const [applying, setApplying] = useState(false);
  // The previous search's in-flight request, so a resubmit aborts it rather
  // than letting an older response land after a newer one and overwrite it.
  const searchAbortRef = useRef<AbortController | null>(null);
  const label = sources === 'tosec' ? 'Find on TOSEC' : 'Find on Demozoo or TOSEC';

  async function search(e: React.FormEvent) {
    e.preventDefault();
    // A one-letter query would match most of the catalog, so the server
    // answers it with nothing -- which must not read as "no such title".
    // Any older search is dropped too, so its late answer cannot land under
    // the hint.
    if (queryTooShort(q)) {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      setSearching(false);
      setResults(null);
      setTooShort(true);
      return;
    }
    setTooShort(false);
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    try {
      const qs = new URLSearchParams({ q });
      if (sources === 'tosec') qs.set('sources', 'tosec');
      const res = await fetch(`/api/identify/search?${qs}`, { signal: controller.signal });
      if (!res.ok) {
        // Leave the previous results on screen: a server error is not the
        // same fact as "nothing matched".
        if (!controller.signal.aborted) toast.error('Could not search');
        return;
      }
      const json = await res.json();
      setResults({ demozoo: json.demozoo ?? [], tosec: json.tosec ?? [] });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast.error('Could not reach the server');
    } finally {
      // Only the still-current request clears the busy state.
      if (searchAbortRef.current === controller) setSearching(false);
    }
  }

  const empty = results && results.demozoo.length === 0 && results.tosec.length === 0;
  // One polite live region, always mounted (a region inserted together with
  // its text is often not announced): the hint, the count, or "nothing".
  const status = tooShort
    ? `Type at least ${MIN_QUERY_LEN} characters to search.`
    : results ? resultsAnnouncement(results.demozoo.length, results.tosec.length, sources) : '';

  return (
    <div data-testid="identify-search">
      <form onSubmit={search} className="flex gap-1.5" data-testid="demozoo-search">
        <input data-testid="demozoo-search-input" value={q} onChange={(e) => { setQ(e.target.value); setTooShort(false); }}
          placeholder={label} aria-label={label}
          className="min-h-11 min-w-0 flex-1 rounded-[10px] border px-3 text-[13px] sm:h-[38px] sm:min-h-0"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }} />
        <button type="submit" disabled={searching} data-testid="identify-search-submit"
          className="min-h-11 rounded-[10px] border px-3 text-[13px] font-medium disabled:opacity-50 sm:h-[38px] sm:min-h-0"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
          Search
        </button>
      </form>
      {/* Visible when it is the whole answer (the hint, or nothing matched);
          screen-reader-only when it only counts the rows shown below. */}
      <p role="status" aria-live="polite" data-testid="identify-search-status"
        className={tooShort || empty ? 'mt-3 text-[12.5px]' : 'sr-only'} style={{ color: 'var(--muted)' }}>
        {status}
      </p>
      {results && !empty && (
        <ul className="mt-3 flex flex-col gap-2" data-testid="identify-search-results">
          {results.demozoo.map((p) => (
            <Candidate key={`d${p.id}`} gameId={gameId} p={p} allowDismiss={false} testId="demozoo-search-result" tag={<Tag source="demozoo" />} />
          ))}
          {results.tosec.map((r) => (
            <TosecRow key={`t${r.key}`} gameId={gameId} r={r} applying={applying} onApplying={setApplying} />
          ))}
        </ul>
      )}
    </div>
  );
}
