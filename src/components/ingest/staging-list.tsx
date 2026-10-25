'use client';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { HelpTip } from '@/components/help/help-tip';
import { sendErrorText, targetLabel, type SendTarget } from '@/lib/send-ui';
import { downloadName, uploadErrorText } from '@/lib/from-amiga-ui';
import { SIGNED_OUT_TEXT, isSignedOutAnswer, mergeStaging, stagingView, type StagingFilter, type ViewRow } from '@/lib/upload-staging';
import { useStaging } from './staging-provider';
import { StagingConfirm } from './staging-confirm';
import { StagingRow } from './staging-row';
import { DiskIcon } from '@/components/ui/disk-icon';
import { FILTERS, EMPTY_UNDER, filterAfterKey } from '@/lib/upload-look';

/** Row actions (spec 2026-10-25-phase-c3-upload-design.md §5.3): outline buttons, destructive ones red, Retry ink. */
const ACT = 'inline-flex h-8 items-center rounded-[8px] px-2.5 text-[12px] font-medium hover:bg-[var(--track)] disabled:opacity-50';
const ACT_BTN = `${ACT} shrink-0`;
const ACT_STYLE = { background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)' } as const;
const ACT_DANGER = { ...ACT_STYLE, color: 'var(--danger-fg)' } as const;
const ACT_PRIMARY = { background: 'var(--ink)', color: 'var(--surface)', border: '1px solid var(--ink)' } as const;

/** A removed row takes its button with it; focus must not fall to <body> (spec §6.3), so it goes to the Staging heading. */
const focusHeadingIfLost = () => requestAnimationFrame(() => {
  if (!document.activeElement || document.activeElement === document.body) {
    document.getElementById('staging-heading')?.focus();
  }
});

/** `stop`: the file is still arriving; the delete then holds only while it is (`?only=receiving`). */
type Confirm = { key: string; id: string; question: string; yes: string; what: string; stop?: boolean };

/** The Upload page's Staging list (spec 2026-10-23 §2): every row moving into the library, to the Amiga and from it. */
export function StagingList({ initialFilter, fallbackTargets }: { initialFilter: StagingFilter; fallbackTargets: SendTarget[] }) {
  const s = useStaging();
  const [filter, setFilter] = useState<StagingFilter>(initialFilter);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const targets = s.targets ?? fallbackTargets;

  const rows = mergeStaging(s.serverRows, [...s.libRows, ...s.upRows]);
  const view = stagingView(rows, filter, s.stalled);
  // The key of the row that last held focus: if a refresh removes that row, its button is gone and focus would fall
  // to <body> (spec §6.3), so it goes to the Staging heading.
  const focusedKey = useRef<string | null>(null);
  const shownKeys = view.shown.map((v) => v.key).join('\n');
  // Rows and the actions each offers: a focused button can go while its row stays (Stop on a file that finished
  // arriving), which drops focus to <body> just as a removed row does.
  const shape = view.shown.map((v) => `${v.key}:${v.actions.join(',')}`).join('\n');
  useEffect(() => {
    const k = focusedKey.current;
    if (!k) return;
    if (!shownKeys.split('\n').includes(k)) {
      focusedKey.current = null;
      focusHeadingIfLost();
      return;
    }
    requestAnimationFrame(() => {
      if (focusedKey.current === k && (!document.activeElement || document.activeElement === document.body)) {
        focusedKey.current = null;
        document.getElementById('staging-heading')?.focus();
      }
    });
  }, [shownKeys, shape]);
  const clearN = view.clearServer.length + view.clearLocal.length;

  const mark = (key: string, on: boolean) => setBusy((b) => {
    const next = new Set(b);
    if (on) next.add(key); else next.delete(key);
    return next;
  });

  /** One row action: the request, a toast on failure, and the list read again once it settles. */
  async function run(key: string, what: string, request: () => Promise<Response>, done?: (res: Response) => void,
    failText: (code: string | undefined, status: number) => string = uploadErrorText, special?: (res: Response) => boolean) {
    mark(key, true);
    s.begin();   // until it settles, no list read is painted: one made meanwhile may predate the change
    try {
      const res = await request();
      // Signed out, the fetch follows the redirect to the sign-in page and answers 200 with HTML: not a success.
      if (isSignedOutAnswer(res)) toast.error(what, { description: SIGNED_OUT_TEXT });
      else if (special?.(res)) { /* handled */ } else if (res.ok) done?.(res);
      else {
        const b = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
        toast.error(what, { description: b?.reason ?? failText(b?.error, res.status) });
      }
    } catch {
      toast.error(what, { description: 'Check the connection and try again.' });
    } finally {
      s.end();
      mark(key, false);
      await s.refreshNow();
    }
  }

  const cancel = (v: ViewRow) => run(v.key, 'Could not cancel',
    () => fetch(`/api/transfers/${encodeURIComponent(idOf(v))}`, { method: 'DELETE' }), undefined,
    (_c, status) => `The server answered ${status}.`,
    (res) => {
      if (res.status !== 409) return false;
      toast.info('Already finished', { description: 'It ended before the cancel arrived.' });
      return true;
    });
  const retry = (v: ViewRow) => run(v.key, 'Could not retry',
    () => fetch(`/api/transfers/${encodeURIComponent(idOf(v))}/retry`, { method: 'POST' }), undefined, sendErrorText);
  const addToLibrary = (v: ViewRow) => run(v.key, 'Not added to the library',
    () => fetch(`/api/uploads/${encodeURIComponent(idOf(v))}/library`, { method: 'POST' }),
    () => { toast.success('Added to the library', { description: v.name }); });
  const sendTo = (v: ViewRow, t: SendTarget) => run(v.key, 'Not sent',
    () => fetch(`/api/uploads/${encodeURIComponent(idOf(v))}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: t.id }),
    }),
    () => { toast.success(`Queued for ${t.name}`, { description: 'It shows in the staging list.' }); });
  const removeUpload = (c: Confirm) => run(c.key, c.what,
    () => fetch(`/api/uploads/${encodeURIComponent(c.id)}${c.stop ? '?only=receiving' : ''}`, { method: 'DELETE' }),
    () => s.removeLocal([c.key]), uploadErrorText,
    // Stop: it finished while the confirm was open, so the server kept it (the list reads it again as stored).
    (res) => {
      if (!c.stop || res.status !== 409) return false;
      toast.info('It finished arriving; it was kept.');
      return true;
    }).finally(() => { setConfirm(null); focusHeadingIfLost(); });

  // A fetch first, so a 404 is a toast and not a saved file called "not found"; the bytes then save under the Amiga name.
  async function download(v: ViewRow) {
    mark(v.key, true);
    try {
      const res = await fetch(`/api/uploads/${encodeURIComponent(idOf(v))}/file`, { cache: 'no-store' });
      // The file itself is not JSON, so only a redirect (to the sign-in page) says signed out here.
      if (res.redirected) {
        toast.error('Not downloaded', { description: SIGNED_OUT_TEXT });
        return;
      }
      if (!res.ok) {
        toast.error('Not downloaded', { description: res.status === 404 ? uploadErrorText('not_found', 404) : uploadErrorText(undefined, res.status) });
        await s.refreshNow();
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = downloadName(v.name);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error('Not downloaded', { description: 'Check the connection and try again.' });
    } finally {
      mark(v.key, false);
    }
  }

  /** Clear the rows by key: the browser's own go at once; the server's go by their keys, and only if still finished. */
  async function clear(keys: { local: string[]; server: string[] }, busyKey: string) {
    s.removeLocal([...keys.local, ...keys.server]);
    focusHeadingIfLost();
    if (keys.server.length === 0) return;
    await run(busyKey, 'Could not clear',
      () => fetch('/api/staging/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: keys.server }) }),
      undefined, (code, status) => (code === 'invalid_body' ? uploadErrorText(code, status) : `The server answered ${status}.`));
  }

  function action(v: ViewRow, a: ViewRow['actions'][number]) {
    const id = `staging-${a}-${v.key}`;
    const disabled = busy.has(v.key);
    switch (a) {
      case 'open':
        return v.gameId && (
          <Link key={a} href={`/games/${encodeURIComponent(v.gameId)}`} data-testid={id}
                className={ACT_BTN} style={ACT_STYLE}>Open title</Link>
        );
      case 'add':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={ACT_BTN} style={ACT_STYLE}
                       aria-label={`Add ${v.name} to the library`} onClick={() => void addToLibrary(v)}>Add to library</button>;
      case 'download':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={ACT_BTN} style={ACT_STYLE}
                       aria-label={`Download ${v.name}`} onClick={() => void download(v)}>Download</button>;
      case 'send':
        return targets.length > 0 && (
          <span key={a} className="relative inline-flex min-w-0 max-w-full">
            <select aria-label={`Send ${v.name} to an Amiga`} data-testid={id} value="" disabled={disabled}
                    className={`${ACT} max-w-full appearance-none pr-7`} style={ACT_STYLE}
                    onChange={(e) => { const t = targets.find((x) => x.id === e.target.value); if (t) void sendTo(v, t); }}>
              <option value="">Send to Amiga…</option>
              {targets.map((t) => <option key={t.id} value={t.id}>{targetLabel(t)}</option>)}
            </select>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
              <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="var(--muted)" strokeWidth="1.5" />
            </svg>
          </span>
        );
      case 'delete':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={ACT_BTN} style={ACT_DANGER}
                       aria-label={`Delete ${v.name}`}
                       onClick={() => setConfirm({ key: v.key, id: idOf(v), question: `Delete ${v.name}? It is the only copy.`, yes: 'Delete', what: 'Not deleted' })}>Delete</button>;
      case 'stop':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={ACT_BTN} style={ACT_DANGER}
                       aria-label={`Stop receiving ${v.name}`}
                       onClick={() => setConfirm({ key: v.key, id: idOf(v), question: `Stop receiving ${v.name}? The part that arrived is deleted.`, yes: 'Stop', what: 'Not stopped', stop: true })}>Stop</button>;
      case 'cancel':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={ACT_BTN} style={ACT_DANGER}
                       aria-label={`Cancel ${v.name}`} onClick={() => void cancel(v)}>Cancel</button>;
      case 'retry':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={ACT_BTN}
                       style={ACT_PRIMARY} aria-label={`Retry ${v.name}`} onClick={() => void retry(v)}>Retry</button>;
      case 'clear':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={ACT_BTN} style={ACT_STYLE}
                       aria-label={`Clear ${v.name}`}
                       onClick={() => void clear(v.row.source === 'server' ? { local: [], server: [v.key] } : { local: [v.key], server: [] }, v.key)}>Clear</button>;
    }
  }

  function onFilterKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;   // Alt+ArrowLeft is the browser's Back
    const next = filterAfterKey(filter, e.key);
    if (!next) return;
    e.preventDefault();
    setFilter(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="staging-filter-${next}"]`)?.focus();
  }

  return (
    // id: a device card's "N files from the Amiga" link lands here (/ingest?from=<board>#from-amiga), on that filter.
    // Spec 2026-10-25-phase-c3-upload-design.md §4: header, filter, refresh state, Clear finished, footer.
    <section id="from-amiga" aria-labelledby="staging-heading" className="flex scroll-mt-24 flex-col gap-3 rounded-[20px] p-4 sm:p-5"
             style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <h2 id="staging-heading" tabIndex={-1} className="rounded-[6px] text-[16px] font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)" style={{ color: 'var(--ink)' }}>Staging</h2>
          <HelpTip topic="from-amiga" />
        </div>
        <div role="radiogroup" aria-label="Show" data-testid="staging-filters" data-value={filter}
             className="seg seg--sm flex-wrap" onKeyDown={onFilterKey}>
          {FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <button key={f.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
                      data-testid={`staging-filter-${f.id}`} className="seg-item gap-1.5" onClick={() => setFilter(f.id)}>
                {f.label}<span className="font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>{view.counts[f.id]}</span>
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        <RefreshState loaded={s.loaded} failed={s.refreshFailed} />
        <button type="button" data-testid="staging-clear-finished" disabled={clearN === 0 || busy.has('clear-finished')}
                className="h-[34px] rounded-[9px] px-3 text-[13px] font-medium hover:bg-[var(--track)] disabled:cursor-default disabled:hover:bg-transparent"
                style={{ border: '1px solid var(--line)', color: clearN === 0 ? 'var(--muted-2)' : 'var(--ink)' }}
                onClick={() => void clear({ local: view.clearLocal, server: view.clearServer }, 'clear-finished')}>
          Clear finished ({clearN})
        </button>
      </div>
        <ul aria-label="Staging" data-testid="staging-list"
            onFocus={(e) => { focusedKey.current = (e.target as HTMLElement).closest('[data-key]')?.getAttribute('data-key') ?? null; }}
            onBlur={(e) => {
              // Forget the row only once focus has left the list (the user went elsewhere); a Tab from one button to
              // another inside it keeps the tracking, and an element removed under focus is not "left" either.
              const el = e.target as HTMLElement;
              const list = e.currentTarget;
              requestAnimationFrame(() => { if (el.isConnected && !list.contains(document.activeElement)) focusedKey.current = null; });
            }}
            className="flex flex-col md:max-h-[36rem] md:overflow-y-auto">
          {view.shown.map((v) => <StagingRow key={v.key} v={v}>{v.actions.map((a) => action(v, a))}</StagingRow>)}
          {view.shown.length === 0 && (rows.length > 0 || s.loaded) && (
            <li data-testid="staging-empty" className="flex flex-col items-center gap-2.5 py-10 text-center">
              <span aria-hidden="true"><DiskIcon color="cream" size={48} /></span>
              <span className="text-[14px]" style={{ color: 'var(--muted)' }}>
                {filter === 'all' || rows.length === 0
                  ? 'Nothing here yet. Drop disks for the library, or files for the Amiga.'
                  : EMPTY_UNDER[filter]}
              </span>
            </li>
          )}
          {view.shown.length === 0 && rows.length === 0 && !s.loaded && (
            <li data-testid="staging-reading" data-state={s.refreshFailed ? 'failed' : 'reading'}
                className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>
              {s.refreshFailed ? "Couldn't read the list. It tries again every few seconds." : 'Reading the list…'}
            </li>
          )}
        </ul>
        <footer className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]" style={{ color: 'var(--muted-2)' }}>
          <span>Files from the Amiga are kept 30 days. Anything here can go on to another place: a file from the Amiga into
            the library, a library disk to the Amiga.</span>
          {s.boards.filter((b) => b.key).map((b) => (
            <span key={b.id} data-testid="from-amiga-key" style={{ overflowWrap: 'anywhere' }}>
              {b.name}: board key <strong className="font-semibold" style={{ color: 'var(--ink)' }}>{b.key}</strong>
            </span>
          ))}
        </footer>
      {confirm && (
        <StagingConfirm question={confirm.question} yes={confirm.yes} busy={busy.has(confirm.key)}
                        onYes={() => void removeUpload(confirm)} onCancel={() => { setConfirm(null); focusHeadingIfLost(); }} />
      )}
    </section>
  );
}

/** A server row's id (send or Amiga file); the actions that take one only appear on server rows. */
const idOf = (v: ViewRow): string => (v.row.source === 'server' ? v.row.id : '');

function RefreshState({ loaded, failed }: { loaded: boolean; failed: boolean }) {
  const state = failed ? 'failed' : loaded ? 'ok' : 'reading';
  return (
    <span data-testid="staging-refresh" data-state={state} className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
      {state === 'failed'
        ? <span role="status" data-testid="staging-refresh-failed" className="font-semibold" style={{ color: 'var(--danger-fg)' }}>Couldn&apos;t refresh</span>
        : state === 'reading' ? 'Reading…' : 'Up to date'}
    </span>
  );
}
