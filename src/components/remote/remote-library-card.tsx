import { Suspense } from 'react';
import { Link } from '@/components/shell/link';
import { lastAnsweredText, remoteErrorText, type RemoteLibraryStatus } from '@/lib/remote/copy';
import type { ShareLibrary } from '@/lib/share/types';
import { RemoteStatus } from './remote-marker';
import { RemoveRemote } from './remove-remote';

export type RemoteCardLibrary = {
  id: string; name: string; host: string; status: RemoteLibraryStatus; lastOkAt: Date | null; lastError: string | null;
};

/** What asking the owner for the library's summary gave: its collections and counts, or why not. */
export type RemoteCardSummary =
  | { ok: true; library: ShareLibrary; status: RemoteLibraryStatus; lastOkAt: Date | null; lastError: string | null }
  | { ok: false; failure: string; detail?: string; status: RemoteLibraryStatus; lastOkAt: Date | null; lastError: string | null };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * One remote library on /remote (spec §4.5): name, the owner's address, the collections it shares, its status and
 * when it last answered, Open and Remove…. An ended library offers only Remove (spec §4.3). The collections line and
 * the fresh status come from asking the owner (cached 60 s), streamed in so one slow owner holds up only its own card.
 */
export function RemoteLibraryCard({ lib, summary }: { lib: RemoteCardLibrary; summary: Promise<RemoteCardSummary> | null }) {
  const ended = lib.status === 'ended';
  const stored = <Facts lib={lib} status={lib.status} lastOkAt={lib.lastOkAt} lastError={lib.lastError} line={ended ? null : 'Asking…'} />;
  return (
    <article data-testid="remote-library-card" data-remote-id={lib.id}
             className="glass-card flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        {ended
          ? <h2 className="text-[17px] font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>{lib.name}</h2>
          : (
            <Link href={`/remote/${encodeURIComponent(lib.id)}`} data-testid="remote-library-open"
                  className="w-fit text-[17px] font-semibold underline-offset-4 [overflow-wrap:anywhere] hover:underline"
                  style={{ color: 'var(--ink)' }}>
              {lib.name}
            </Link>
          )}
        <span data-testid="remote-library-host" className="font-mono text-[12.5px]" style={{ color: 'var(--muted)' }}>{lib.host}</span>
        {summary
          ? <Suspense fallback={stored}><Summary lib={lib} summary={summary} /></Suspense>
          : stored}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!ended && (
          <Link href={`/remote/${encodeURIComponent(lib.id)}`}
                className="btn-like inline-flex h-9 items-center rounded-[9px] px-3.5 text-[13px] font-semibold text-white max-sm:min-h-11"
                style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
            Open
          </Link>
        )}
        <RemoveRemote id={lib.id} name={lib.name} />
      </div>
    </article>
  );
}

async function Summary({ lib, summary }: { lib: RemoteCardLibrary; summary: Promise<RemoteCardSummary> }) {
  const s = await summary;
  const line = s.ok
    ? [
      s.library.collections.length > 0
        ? s.library.collections.map((c) => c.name).join(', ')
        : 'All titles',
      plural(s.library.titles, 'title', 'titles'),
      plural(s.library.disks, 'disk', 'disks'),
    ].join(' · ')
    : s.status === 'ok' ? remoteErrorText(s.failure, lib.host, s.detail) : null;
  return <Facts lib={lib} status={s.status} lastOkAt={s.lastOkAt} lastError={s.lastError} line={line} />;
}

function Facts({ lib, status, lastOkAt, lastError, line }: {
  lib: RemoteCardLibrary; status: RemoteLibraryStatus; lastOkAt: Date | null; lastError: string | null; line: string | null;
}) {
  return (
    <>
      {line && <span data-testid="remote-library-collections" className="text-[13.5px]" style={{ color: 'var(--ink)' }}>{line}</span>}
      <span className="flex flex-wrap items-center gap-2">
        <RemoteStatus status={status} host={lib.host} lastError={lastError} />
        <span data-testid="remote-library-last" className="text-[12.5px]" style={{ color: 'var(--muted-2)' }}>
          {lastAnsweredText(lastOkAt)}
        </span>
      </span>
    </>
  );
}
