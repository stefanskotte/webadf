'use client';

/* eslint-disable @next/next/no-img-element */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

// Redeclared, not imported: @/lib/demozoo/queries pulls the database into the
// browser bundle (the same reason search-box.tsx redeclares its types).
export interface ProductionLite {
  id: number; title: string; releaseYear: number | null; types: string[]; groups: string[];
  url: string; screenshots: Array<{ sha1: string; url: string; ordinal: number }>;
}

async function send(url: string, method: 'POST' | 'DELETE', body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method, headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { toast.error('Could not update the Demozoo link'); return false; }
    return true;
  } catch {
    toast.error('Could not reach the server');
    return false;
  }
}

const byline = (p: ProductionLite) => [p.groups.join(', '), p.releaseYear, p.types.join(', ')].filter(Boolean).join(' · ');

// `label` defaults to "Unlink" (the linked panel's usage) but the suggestion
// card also mounts this same button as "Restore original title" (R16): when
// the link is gone but a Demozoo import still owns the title -- a later
// import re-matched a blob away from its link -- unlinking is the repair
// path, since unlinkDemozoo() re-derives the title once the link clears.
export function UnlinkButton({ gameId, label = 'Unlink' }: { gameId: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" data-testid="demozoo-unlink" disabled={busy}
      className="rounded-full px-3 py-1 text-[12.5px] font-semibold disabled:opacity-50" style={{ color: 'var(--muted)' }}
      onClick={async () => { setBusy(true); if (await send(`/api/games/${gameId}/demozoo`, 'DELETE')) router.refresh(); setBusy(false); }}>
      {label}
    </button>
  );
}

function Candidate({ gameId, p, allowDismiss }: { gameId: string; p: ProductionLite; allowDismiss: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const thumb = p.screenshots[0];
  return (
    <li data-testid="demozoo-suggestion" data-production-id={p.id}
        className="flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center" style={{ background: 'var(--glass-strong)' }}>
      <div className="h-[72px] w-[92px] shrink-0 overflow-hidden rounded-md" style={{ background: 'var(--hairline)' }}>
        {thumb && <img src={thumb.url} alt={`${p.title} screenshot`} loading="lazy" decoding="async" className="h-full w-full object-contain" />}
      </div>
      <div className="min-w-0 flex-1">
        <a href={p.url} target="_blank" rel="noreferrer noopener" className="font-semibold" style={{ color: 'var(--amber-text)' }}>{p.title}</a>
        <div className="text-[12.5px]" style={{ color: 'var(--muted)' }}>{byline(p)}</div>
      </div>
      <div className="flex gap-2">
        <button type="button" data-testid="demozoo-use" disabled={busy}
          className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--primary-action)' }}
          onClick={async () => { setBusy(true); if (await send(`/api/games/${gameId}/demozoo`, 'POST', { productionId: p.id })) router.refresh(); setBusy(false); }}>
          Use this
        </button>
        {allowDismiss && (
          <button type="button" data-testid="demozoo-dismiss" disabled={busy}
            className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50" style={{ color: 'var(--muted)' }}
            onClick={async () => { setBusy(true); if (await send(`/api/games/${gameId}/demozoo/dismiss`, 'POST', { productionId: p.id })) router.refresh(); setBusy(false); }}>
            Not this
          </button>
        )}
      </div>
    </li>
  );
}

export function DemozooSuggestions({ gameId, suggestions, restoreTitle }: {
  gameId: string; suggestions: ProductionLite[];
  /** R16: link is null but the game's title still reads metadataSource ===
   *  'demozoo' -- a later import re-matched a blob away from its link. Shows
   *  a short explanation and reuses UnlinkButton (relabelled) as the repair
   *  path: unlinkDemozoo() re-derives the title once nothing claims it. */
  restoreTitle?: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ProductionLite[] | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch(`/api/demozoo/search?q=${encodeURIComponent(q)}`);
      setResults(res.ok ? await res.json() : []);
    } catch { toast.error('Could not reach the server'); }
  }

  return (
    <div className="px-4 pb-3 sm:px-7" data-testid="demozoo-suggestions">
      <div className="glass-card p-5">
        {restoreTitle && (
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
              This title&apos;s name came from Demozoo.
            </span>
            <UnlinkButton gameId={gameId} label="Restore original title" />
          </div>
        )}
        {suggestions.length > 0 && (
          <>
            <h2 className="mb-3 text-[14px] font-semibold">Possibly on Demozoo</h2>
            <ul className="flex flex-col gap-2">
              {suggestions.map((p) => <Candidate key={p.id} gameId={gameId} p={p} allowDismiss />)}
            </ul>
          </>
        )}
        <form onSubmit={search} className={`${suggestions.length ? 'mt-4' : ''} flex flex-col gap-2 sm:flex-row`} data-testid="demozoo-search">
          <input data-testid="demozoo-search-input" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Find on Demozoo" aria-label="Find on Demozoo"
            className="min-w-0 flex-1 rounded-full px-4 py-1.5 text-[13px]" style={{ background: 'var(--input-bg)' }} />
          <button type="submit" className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>Search</button>
        </form>
        {results && (
          <ul className="mt-3 flex flex-col gap-2">
            {results.length === 0 && <li className="text-[12.5px]" style={{ color: 'var(--muted)' }}>No Demozoo production with that title.</li>}
            {results.map((p) => (
              <div key={p.id} data-testid="demozoo-search-result"><Candidate gameId={gameId} p={p} allowDismiss={false} /></div>
            ))}
          </ul>
        )}
        <div className="mt-4 text-[12px]" style={{ color: 'var(--muted)' }}>
          Suggestions from <a href="https://demozoo.org" target="_blank" rel="noreferrer noopener" className="font-semibold" style={{ color: 'var(--amber-text)' }}>Demozoo</a>. Nothing is linked until you choose.
        </div>
      </div>
    </div>
  );
}
