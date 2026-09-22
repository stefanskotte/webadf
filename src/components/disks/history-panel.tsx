'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { ejectMessage } from '@/lib/mount-wording';
import { fromQuery } from '@/lib/trail';
import type { HistoryVersion } from '@/lib/disk-history/history';
import type { TreeChange } from '@/lib/disk-history/diff';
import { fmtTimeUtc } from '@/lib/format';

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
        className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold"
        style={{ background: style.bg, color: style.fg }}
      >
        {style.mark}
      </span>
      <span className="min-w-0 break-words" style={{ color: 'var(--muted)' }}>
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
    <ul className="flex flex-col gap-1 text-[12px]" data-testid={`changes-${version.seq}`}>
      {version.changes.map((c) => (
        <ChangeRow key={`${c.kind}:${c.path}`} change={c} />
      ))}
    </ul>
  );
}

export function HistoryPanel({
  diskId, from, versions, viewingSeq, mountedMessage,
}: {
  diskId: string;
  /** The library collection this page arrived from, carried onward into Browse links -- same convention as the page's own "Return to current version" link. */
  from: string | undefined;
  /** Newest first, as `loadHistory` returns it. Empty means this disk has never been edited. */
  versions: HistoryVersion[];
  /** The `?version=` currently on screen, or null while viewing the head. */
  viewingSeq: number | null;
  /**
   * The wording for a device holding this disk RIGHT NOW, computed by the
   * page from the same `findHolder` call editing already refuses on -- null
   * when nothing holds it. Known up front so Restore can say so before
   * anyone tries, not only after a 409; still re-checked by the server on
   * every actual attempt below, since a device can mount between this page
   * loading and a click.
   */
  mountedMessage: string | null;
}) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<HistoryVersion | null>(null);
  const [busy, setBusy] = useState(false);
  // A 409 hit mid-session, for the race the proactive `mountedMessage` prop
  // cannot see (the page rendered before a device mounted). `?? ` in the
  // render below prefers the server's own fresh word on every reload;
  // this only fills the gap between reloads.
  const [reactiveMounted, setReactiveMounted] = useState<string | null>(null);

  const mountedBanner = mountedMessage ?? reactiveMounted;
  const oldestSeq = versions.length > 0 ? versions[versions.length - 1].seq : null;
  const shown = showAll ? versions : versions.slice(0, SHOWN_BY_DEFAULT);

  async function confirmRestore(version: HistoryVersion) {
    setBusy(true);
    try {
      const res = await fetch(`/api/disks/${diskId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seq: version.seq }),
      });
      const data: { error?: string; reason?: string; recorded?: boolean } | null = await res.json().catch(() => null);

      if (!res.ok) {
        if (res.status === 409 && data?.error === 'mounted' && typeof data.reason === 'string') {
          const message = ejectMessage(data.reason);
          setReactiveMounted(message);
          toast.error(message);
        } else if (res.status === 409) {
          toast.error('This disk changed since the page loaded.', {
            description: 'Reloading the history so it matches.',
          });
          router.refresh();
        } else if (res.status === 404) {
          toast.error('That version is no longer available.');
          router.refresh();
        } else if (res.status === 503) {
          toast.error('The disk image could not be read from storage right now.');
        } else {
          toast.error('Could not restore this version.');
        }
        return;
      }

      // A no-op restore (the target's bytes already were the head -- reachable
      // whenever a disk went A -> B -> A) records nothing and refreshes into an
      // identical list. Saying "Restored" there reads as a silently failed
      // click, so it says what actually happened instead.
      if (data?.recorded === false) {
        toast.success('Nothing to restore', {
          description: `Version ${version.seq} is already this disk's current content.`,
        });
      } else {
        toast.success(`Restored to version ${version.seq}`, { description: version.label });
      }
      setRestoreTarget(null);
      // The live-state poller will notice a rewritten head on its own, but
      // whoever just clicked Restore should not wait out its cycle to see
      // the disk they're looking at reflect it.
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    // `id` is the anchor the library card's history button lands on
    // (game-grid.tsx), and scroll-mt keeps the heading clear of the shell's
    // header rather than tucking it underneath.
    <div id="disk-history" className="glass-card flex scroll-mt-20 flex-col gap-3 p-4" data-testid="history-panel">
      <h2 className="text-[13px] font-bold" style={{ color: 'var(--ink)' }}>History</h2>

      {mountedBanner && (
        <p
          id="history-mounted-reason"
          className="text-[12.5px] font-semibold"
          style={{ color: 'var(--amber-text)' }}
          data-testid="history-mounted-notice"
        >
          {mountedBanner}{' '}
          <Link href="/devices" className="underline underline-offset-2">Eject</Link>
        </p>
      )}

      {versions.length === 0 ? (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid="history-empty">
          As uploaded — nothing has changed this disk yet.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {shown.map((version) => {
              // Viewing this exact row: either it's the one named in
              // `?version=`, or nothing is named and this is the head --
              // the same two-sided rule the page uses for its own banner.
              const isViewing = viewingSeq !== null ? version.seq === viewingSeq : version.isHead;
              // Linking a Browse href to the HEAD's own seq via `?version=`
              // would trip Task 3's "historical" gate for what is actually
              // the current version -- it has no way to tell "the seq you
              // asked for happens to be the head" from "you asked for an
              // old one". Route the head's Browse back to the plain URL
              // instead; every other row still gets its own `?version=`.
              const browseHref = version.isHead
                ? `/disks/${diskId}/files${fromQuery(from)}`
                : `/disks/${diskId}/files?version=${version.seq}${from ? `&from=${encodeURIComponent(from)}` : ''}`;

              return (
                <li
                  key={version.seq}
                  data-testid={`version-${version.seq}`}
                  data-head={version.isHead || undefined}
                  className="rounded-lg p-3"
                  style={{
                    background: isViewing ? 'var(--glass-strong)' : 'transparent',
                    border: `1px solid ${isViewing ? 'var(--hairline-strong)' : 'var(--hairline)'}`,
                  }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                        Version {version.seq} — {version.label}
                      </p>
                      <p className="text-[11.5px]" style={{ color: 'var(--muted-2)' }}>
                        {formatVersionTime(version.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isViewing ? (
                        <span
                          className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                          style={{ background: 'var(--glass-strong)', color: 'var(--muted)' }}
                          data-testid={`viewing-${version.seq}`}
                        >
                          Viewing
                        </span>
                      ) : (
                        <Link
                          href={browseHref}
                          data-testid={`browse-${version.seq}`}
                          className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                          style={{ border: '1px solid var(--hairline)', color: 'var(--ink)' }}
                        >
                          Browse
                        </Link>
                      )}
                      {version.isHead ? (
                        // Stated, not just absent -- an omitted Restore
                        // button here would be indistinguishable from one
                        // that failed to render for some other reason.
                        <span
                          className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                          style={{ background: 'var(--success-bg)', color: 'var(--success-fg)' }}
                          data-testid={`current-${version.seq}`}
                        >
                          Current
                        </span>
                      ) : (
                        <button
                          type="button"
                          // Keyed off `mountedBanner`, not the page-load-only
                          // `mountedMessage` -- a 409 arriving mid-session
                          // (a board mounting the disk after this page
                          // loaded) already shows the refusal via
                          // `reactiveMounted`; the control has to agree with
                          // it, or a person can keep clicking a button that
                          // reads as live but is known to be refused.
                          disabled={!!mountedBanner}
                          title={mountedBanner ?? undefined}
                          aria-describedby={mountedBanner ? 'history-mounted-reason' : undefined}
                          onClick={() => setRestoreTarget(version)}
                          data-testid={`restore-${version.seq}`}
                          className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50"
                          style={{ background: 'var(--primary-action)' }}
                        >
                          Restore
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-2">
                    <ChangesBody version={version} isOldest={version.seq === oldestSeq} />
                  </div>
                </li>
              );
            })}
          </ul>

          {versions.length > SHOWN_BY_DEFAULT && (
            <button
              type="button"
              onClick={() => setShowAll((s) => !s)}
              data-testid="history-show-all"
              className="self-start text-[12px] font-semibold underline underline-offset-2"
              style={{ color: 'var(--muted)' }}
            >
              {showAll ? 'Show fewer' : `Show all ${versions.length} versions`}
            </button>
          )}
        </>
      )}

      {restoreTarget && createPortal((
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgb(11 18 28 / 0.55)' }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Restore version ${restoreTarget.seq}`}
            data-testid="restore-dialog"
            className="glass-card w-full max-w-[440px] p-6 text-left"
          >
            <h2 className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>
              Restore version {restoreTarget.seq}?
            </h2>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
              <strong style={{ color: 'var(--ink)' }}>{restoreTarget.label}</strong>
              {' · '}
              {formatVersionTime(restoreTarget.createdAt)}
            </p>
            <p className="mt-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>
              This becomes the disk&apos;s current version. Every version after it stays in
              history, so you can restore forward again.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="restore-cancel"
                disabled={busy}
                onClick={() => setRestoreTarget(null)}
                className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50"
                style={{ color: 'var(--muted)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="restore-confirm"
                disabled={busy}
                onClick={() => confirmRestore(restoreTarget)}
                className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
                style={{ background: 'var(--primary-action)' }}
              >
                {busy ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}
