'use client';

import { useState } from 'react';
import { Link } from '@/components/shell/link';
import { fromQuery, type TrailView } from '@/lib/trail';
import type { HistoryVersion } from '@/lib/disk-history/history';
import type { TreeChange } from '@/lib/disk-history/diff';
import { fmtTimeUtc } from '@/lib/format';
import { HelpTip } from '@/components/help/help-tip';
import { changeCounts, openByDefault } from '@/lib/disk-files-look';
import { useRestore } from '@/components/disks/restore-dialog';

/**
 * The History panel: every version of this disk, newest first, what changed
 * at each step, and the two actions the time machine offers -- browse it
 * read-only (Task 3's `?version=`) or restore it (Task 4's route).
 *
 * THE LIST ITSELF IS SERVER-RENDERED: `versions` is computed once, on the
 * server, by the page (`loadHistory`) and handed down as a plain prop, the
 * same shape `FileTree` already takes its `entries` from `readVolume`. This
 * file is a client component only because a row's Browse link needs to know
 * which version is currently on screen, and Restore needs a confirm dialog
 * and a fetch -- not because the LIST is fetched or built here. Nothing in
 * this file re-derives the history or asks the server for it again; the
 * "show all" toggle below only reveals rows already in `versions`.
 */

const SHOWN_BY_DEFAULT = 20;

/**
 * A fixed, timezone-independent rendering -- never the viewer's locale or
 * timezone. Two people (or a server-rendered pass and a client hydration
 * pass of THIS SAME client component, which can run in different zones)
 * must read the identical string for the identical Date, and a history list
 * is exactly the place where "which one happened first" has to be
 * unambiguous.
 */
const formatVersionTime = fmtTimeUtc;

const CHANGE_STYLE: Record<TreeChange['kind'], { bg: string; fg: string; mark: string; word: string }> = {
  added: { bg: 'var(--success-bg)', fg: 'var(--success-fg)', mark: '+', word: 'added' },
  changed: { bg: 'var(--warning-bg)', fg: 'var(--warning-fg)', mark: '~', word: 'changed' },
  removed: { bg: 'var(--danger-bg)', fg: 'var(--danger-fg)', mark: '−', word: 'removed' },
};

function ChangeRow({ change }: { change: TreeChange }) {
  const style = CHANGE_STYLE[change.kind];
  return (
    <li className="flex items-start gap-1.5">
      <span
        aria-hidden
        className="mt-px flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-bold"
        style={{ background: style.bg, color: style.fg }}
      >
        {style.mark}
      </span>
      <span className="min-w-0 break-words font-mono" style={{ color: 'var(--muted)' }}>
        {change.path}
        {change.isDir ? '/' : ''}
        <span className="sr-only"> ({style.word})</span>
      </span>
    </li>
  );
}

/** What one version's changes list renders as, including the two ways there is nothing to list. */
function ChangesBody({ version, isOldest }: { version: HistoryVersion; isOldest: boolean }) {
  if (version.sectorNote !== null) {
    return (
      <p className="text-[12px] italic" style={{ color: 'var(--muted-2)' }}>
        {version.sectorNote}
      </p>
    );
  }
  if (version.changes.length === 0) {
    return (
      <p className="text-[12px] italic" style={{ color: 'var(--muted-2)' }}>
        {isOldest ? 'No earlier version to compare.' : 'No file changes.'}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 font-mono text-[12px]" data-testid={`changes-${version.seq}`}>
      {version.changes.map((c) => (
        <ChangeRow key={`${c.kind}:${c.path}`} change={c} />
      ))}
    </ul>
  );
}

function Counts({ version }: { version: HistoryVersion }) {
  const n = changeCounts(version.changes);
  const chips = ([
    ['added', n.added, '+', 'var(--success-bg)', 'var(--success-fg)'],
    ['changed', n.changed, '~', 'var(--warning-bg)', 'var(--warning-fg)'],
    ['removed', n.removed, '−', 'var(--danger-bg)', 'var(--danger-fg)'],
  ] as const).filter(([, count]) => count > 0);
  if (chips.length === 0) return null;
  return (
    <span className="flex shrink-0 gap-1 font-mono text-[11px] font-semibold" data-testid={`version-counts-${version.seq}`}>
      {chips.map(([word, count, mark, bg, fg]) => (
        <span key={word} className="rounded-[5px] px-1.5" style={{ background: bg, color: fg }}>
          {mark}{count}<span className="sr-only"> {word}</span>
        </span>
      ))}
    </span>
  );
}

export function HistoryPanel({
  diskId, from, view = null, versions, viewingSeq, mountedMessage,
}: {
  diskId: string;
  /** The library collection this page arrived from, carried onward into Browse links -- same convention as the page's own "Return to current version" link. */
  from: string | undefined;
  /** The library's grid or table, carried with `from` (trail.ts TrailView). */
  view?: TrailView;
  /** Newest first, as `loadHistory` returns it. Empty means this disk has never been edited. */
  versions: HistoryVersion[];
  /** The `?version=` currently on screen, or null while viewing the head. */
  viewingSeq: number | null;
  /**
   * The wording for a device holding this disk RIGHT NOW, computed by the page from the same `findHolder` call
   * editing already refuses on -- null when nothing holds it. Known up front so Restore… can say so before anyone
   * tries; still re-checked by the server on every attempt, since a device can mount after this page loaded.
   */
  mountedMessage: string | null;
}) {
  const { ask, reactiveMounted } = useRestore();
  const [showAll, setShowAll] = useState(false);
  // Ruling 24: the head and the version on screen start open; the rest are one click away. Only what the person
  // toggled is state -- the defaults are recomputed each render, so a head that appears after an edit (the page
  // refreshes in place, this component stays mounted) opens by itself instead of staying closed.
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(new Map());
  const defaults = openByDefault(versions, viewingSeq);
  const isOpenFor = (seq: number) => toggled.get(seq) ?? defaults.has(seq);
  const toggle = (seq: number) => setToggled((prev) => new Map(prev).set(seq, !(prev.get(seq) ?? defaults.has(seq))));

  // `??` prefers the server's fresh word on every reload; the reactive one only fills the gap between reloads.
  const mountedBanner = mountedMessage ?? reactiveMounted;
  const oldestSeq = versions.length > 0 ? versions[versions.length - 1].seq : null;
  const shown = showAll ? versions : versions.slice(0, SHOWN_BY_DEFAULT);

  return (
    // `id` is the anchor the library card's history button lands on (game-grid.tsx); scroll-mt keeps the heading
    // clear of the shell's header.
    <aside id="disk-history" aria-labelledby="history-heading" data-testid="history-panel"
           className="flex scroll-mt-20 flex-col overflow-hidden rounded-[20px]"
           style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
      <div className="flex flex-col gap-1 border-b px-[18px] pb-3 pt-4" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center gap-1" style={{ color: 'var(--ink)' }}>
          <h2 id="history-heading" tabIndex={-1}
              className="rounded-[6px] text-[15px] font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)">
            History
          </h2>
          <HelpTip topic="write-back" />
        </div>
        <p className="text-[12px] leading-[1.5]" style={{ color: 'var(--muted-2)' }}>
          Every write from the drive or this page saves a version. Restoring adds a new version — nothing is lost.
        </p>
        {mountedBanner && (
          <p id="history-mounted-reason" className="text-[13px] font-semibold" style={{ color: 'var(--amber-text)' }}
             data-testid="history-mounted-notice">
            {mountedBanner}{' '}
            <Link href="/devices" className="underline underline-offset-2">Eject</Link>
          </p>
        )}
      </div>

      {versions.length === 0 ? (
        <p className="px-[18px] py-4 text-[13px]" style={{ color: 'var(--muted)' }} data-testid="history-empty">
          As uploaded — nothing has changed this disk yet.
        </p>
      ) : (
        <>
          <ol className="flex flex-col p-2 md:max-h-[840px] md:overflow-y-auto">
            {shown.map((version, i) => {
              // Viewing this exact row: either it's the one named in `?version=`, or nothing is named and this is
              // the head -- the same two-sided rule the page uses for its own banner.
              const isViewing = viewingSeq !== null ? version.seq === viewingSeq : version.isHead;
              // A Browse href to the HEAD's own seq via `?version=` would trip the page's "historical" gate for what
              // is actually the current version, so the head's Browse goes to the plain URL.
              const browseHref = version.isHead
                ? `/disks/${diskId}/files${fromQuery(from, view)}`
                : `/disks/${diskId}/files?version=${version.seq}${from ? `&from=${encodeURIComponent(from)}` : ''}${view ? `&view=${view}` : ''}`;
              const isOpen = isOpenFor(version.seq);
              const dot = version.isHead
                ? { background: 'var(--ink)', borderColor: 'var(--ink)' }
                : isViewing
                  ? { background: 'var(--fetch-dot)', borderColor: 'var(--fetch-dot)' }
                  : { background: 'var(--surface)', borderColor: 'var(--dash)' };

              return (
                <li key={version.seq} data-testid={`version-${version.seq}`} data-head={version.isHead || undefined}
                    className="relative pl-[22px]">
                  <span aria-hidden className="absolute left-[13px] top-0 w-[2px]"
                        style={{ background: 'var(--line)', bottom: i === shown.length - 1 ? 'auto' : 0, height: i === shown.length - 1 ? 16 : undefined }} />
                  <span aria-hidden className="absolute left-2 top-4 size-3 rounded-full border-2" style={dot} />
                  <div className="ml-1.5 flex flex-col gap-1.5 rounded-[12px] p-2.5 hover:bg-[var(--surface-2)]"
                       style={isViewing ? { background: 'var(--viewing-bg)' } : undefined}>
                    <button type="button" data-testid={`version-toggle-${version.seq}`} aria-expanded={isOpen}
                            aria-controls={`version-body-${version.seq}`} onClick={() => toggle(version.seq)}
                            className="flex items-start gap-2 rounded-[6px] text-left"
                            style={{ color: 'var(--ink)' }}>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-[13px] font-semibold [overflow-wrap:anywhere]">
                          Version {version.seq} · {version.label}
                        </span>
                        <span className="font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>
                          {formatVersionTime(version.createdAt)}
                        </span>
                      </span>
                      <Counts version={version} />
                      {version.isHead && (
                        // Stated in words, open or closed -- an omitted marker would be indistinguishable from one
                        // that failed to render.
                        <span className="shrink-0 rounded-[5px] px-[7px] text-[11px] font-semibold"
                              style={{ background: 'var(--ink)', color: 'var(--surface)' }}
                              data-testid={`current-${version.seq}`}>
                          Current
                        </span>
                      )}
                    </button>
                    {isOpen && (
                      <div id={`version-body-${version.seq}`} data-testid={`version-body-${version.seq}`}
                           className="flex flex-col gap-1.5">
                        <ChangesBody version={version} isOldest={version.seq === oldestSeq} />
                        <div className="flex items-center gap-1.5 pt-0.5">
                          {isViewing ? (
                            <span className="px-1 text-[12px] font-semibold" style={{ color: 'var(--muted)' }}
                                  data-testid={`viewing-${version.seq}`}>
                              Viewing
                            </span>
                          ) : (
                            <Link href={browseHref} data-testid={`browse-${version.seq}`}
                                  className="inline-flex h-[30px] items-center rounded-[8px] border px-2.5 text-[12px] font-medium"
                                  style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
                              Browse
                            </Link>
                          )}
                          {!version.isHead && (
                            // Keyed off `mountedBanner`, not the page-load-only `mountedMessage`: a 409 arriving
                            // mid-session must disable this too, or it reads as live while known to be refused.
                            <button type="button" data-testid={`restore-${version.seq}`} onClick={() => ask(version)}
                                    disabled={!!mountedBanner} title={mountedBanner ?? undefined}
                                    aria-describedby={mountedBanner ? 'history-mounted-reason' : undefined}
                                    className="inline-flex h-[30px] items-center rounded-[8px] px-2.5 text-[12px] font-semibold disabled:opacity-50"
                                    style={{ color: 'var(--amber-text)' }}>
                              Restore…
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {versions.length > SHOWN_BY_DEFAULT && (
            <button type="button" onClick={() => setShowAll((x) => !x)} data-testid="history-show-all"
                    className="self-start px-2.5 pb-2 text-[12px] font-semibold underline underline-offset-2"
                    style={{ color: 'var(--muted)' }}>
              {showAll ? 'Show fewer' : `Show all ${versions.length} versions`}
            </button>
          )}
        </>
      )}
    </aside>
  );
}
