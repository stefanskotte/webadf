'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { HdTag } from '@/components/disks/hd-tag';
import { UploadCard } from '@/components/ingest/upload-card';
import { HelpTip } from '@/components/help/help-tip';
import { adfDensity, isHfeFilename } from '@/lib/disk-format';
import { sendErrorText, targetLabel, type SendTarget } from '@/lib/send-ui';
import { downloadName, uploadErrorText } from '@/lib/from-amiga-ui';
import { SIGNED_OUT_TEXT, isSignedOutAnswer, mergeStaging, stagingView, type StagingFilter, type Tone, type ViewRow } from '@/lib/upload-staging';
import { useStaging } from './staging-provider';
import { StagingConfirm } from './staging-confirm';
import { FILTERS, EMPTY_UNDER } from '@/lib/upload-look';

const btn = 'rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50';
const quiet = { background: 'var(--glass-strong)', color: 'var(--ink)', border: '1px solid var(--hairline-strong)' } as const;

const PILL: Record<ViewRow['kind'], string> = { lib: '↓ To library', out: '→ To Amiga', in: '← From Amiga' };
const DOT: Record<Tone, string> = {
  done: 'var(--success-fg)', busy: 'var(--accent-amber)', wait: 'var(--muted)', fail: 'var(--danger-fg)',
};

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
    }).finally(() => setConfirm(null));

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
                className="text-[12px] font-semibold underline underline-offset-2" style={{ color: 'var(--ink)' }}>Open title</Link>
        );
      case 'add':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={btn} style={quiet}
                       aria-label={`Add ${v.name} to the library`} onClick={() => void addToLibrary(v)}>Add to library</button>;
      case 'download':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={btn} style={quiet}
                       aria-label={`Download ${v.name}`} onClick={() => void download(v)}>Download</button>;
      case 'send':
        return targets.length > 0 && (
          <select key={a} aria-label={`Send ${v.name} to an Amiga`} data-testid={id} value="" disabled={disabled}
                  className="rounded-lg px-2 py-1 text-[12px]" style={quiet}
                  onChange={(e) => { const t = targets.find((x) => x.id === e.target.value); if (t) void sendTo(v, t); }}>
            <option value="">Send to Amiga…</option>
            {targets.map((t) => <option key={t.id} value={t.id}>{targetLabel(t)}</option>)}
          </select>
        );
      case 'delete':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={btn} style={quiet}
                       aria-label={`Delete ${v.name}`}
                       onClick={() => setConfirm({ key: v.key, id: idOf(v), question: `Delete ${v.name}? It is the only copy.`, yes: 'Delete', what: 'Not deleted' })}>Delete</button>;
      case 'stop':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={btn} style={quiet}
                       aria-label={`Stop receiving ${v.name}`}
                       onClick={() => setConfirm({ key: v.key, id: idOf(v), question: `Stop receiving ${v.name}? The part that arrived is deleted.`, yes: 'Stop', what: 'Not stopped', stop: true })}>Stop</button>;
      case 'cancel':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={btn} style={quiet}
                       aria-label={`Cancel ${v.name}`} onClick={() => void cancel(v)}>Cancel</button>;
      case 'retry':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={`${btn} text-white`}
                       style={{ background: 'var(--primary-action)' }} aria-label={`Retry ${v.name}`} onClick={() => void retry(v)}>Retry</button>;
      case 'clear':
        return <button key={a} type="button" data-testid={id} disabled={disabled} className={btn} style={quiet}
                       aria-label={`Clear ${v.name}`}
                       onClick={() => void clear(v.row.source === 'server' ? { local: [], server: [v.key] } : { local: [v.key], server: [] }, v.key)}>Clear</button>;
    }
  }

  const meta = (
    <>
      {s.boards.filter((b) => b.key).map((b) => (
        <span key={b.id} className="text-[12px]" style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }} data-testid="from-amiga-key">
          {b.name}: board key <strong style={{ color: 'var(--ink)' }}>{b.key}</strong>
        </span>
      ))}
      {s.refreshFailed && (
        <span role="status" className="text-[12px] font-semibold" style={{ color: 'var(--danger-fg)' }} data-testid="staging-refresh-failed">
          Couldn&apos;t refresh
        </span>
      )}
      {clearN > 0 && (
        <button type="button" data-testid="staging-clear-finished" disabled={busy.has('clear-finished')} className={btn} style={quiet}
                onClick={() => void clear({ local: view.clearLocal, server: view.clearServer }, 'clear-finished')}>
          Clear finished ({clearN})
        </button>
      )}
    </>
  );

  return (
    // id: a device card's "N files from the Amiga" link lands here (/ingest?from=<board>#from-amiga), on that filter.
    <section id="from-amiga">
      <UploadCard id="staging-heading" title="Staging" help={<HelpTip topic="from-amiga" />} meta={meta}>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1 self-start rounded-xl p-1"
             style={{ border: '1px solid var(--hairline-strong)', background: 'var(--glass-subtle)' }}>
          {FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <button key={f.id} type="button" aria-pressed={on} data-testid={`staging-filter-${f.id}`} onClick={() => setFilter(f.id)}
                      className="rounded-lg px-3 py-1 text-[12px] font-semibold"
                      style={on ? { background: 'var(--ink)', color: 'var(--glass-strong)' } : { color: 'var(--muted)' }}>
                {f.label} <span className="font-mono">{view.counts[f.id]}</span>
              </button>
            );
          })}
        </div>

        <ul aria-label="Staging" data-testid="staging-list"
            className="flex flex-col overflow-hidden rounded-xl md:max-h-[36rem] md:overflow-y-auto" style={{ border: '1px solid var(--hairline-strong)', background: 'var(--glass-subtle)' }}>
          {view.shown.map((v) => <Row key={v.key} v={v}>{v.actions.map((a) => action(v, a))}</Row>)}
          {view.shown.length === 0 && (rows.length > 0 || s.loaded) && (
            <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }} data-testid="staging-empty">
              {filter === 'all' || rows.length === 0
                ? 'Nothing here yet. Drop disks for the library, or files for the Amiga.'
                : EMPTY_UNDER[filter]}
            </li>
          )}
          {view.shown.length === 0 && rows.length === 0 && !s.loaded && (
            <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>Reading the list…</li>
          )}
        </ul>
        <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
          Files from the Amiga are kept 30 days. Anything here can go on to another place: a file from the Amiga into the
          library, a library disk to the Amiga.
        </p>
      </UploadCard>
      {confirm && (
        <StagingConfirm question={confirm.question} yes={confirm.yes} busy={busy.has(confirm.key)}
                        onYes={() => void removeUpload(confirm)} onCancel={() => setConfirm(null)} />
      )}
    </section>
  );
}

/** A server row's id (send or Amiga file); the actions that take one only appear on server rows. */
const idOf = (v: ViewRow): string => (v.row.source === 'server' ? v.row.id : '');

function Row({ v, children }: { v: ViewRow; children: React.ReactNode }) {
  const hd = v.kind === 'lib' && !isHfeFilename(v.name) && adfDensity(v.row.sizeBytes) === 'hd';
  // A refused library file says why in its status ("Failed · No disk images inside"); the reason keeps ingest-note.
  const failNote = v.row.source === 'lib' && v.row.state === 'failed' && v.row.note ? v.row.note : null;
  return (
    <li data-testid="staging-row" data-kind={v.kind} data-state={v.state} data-key={v.key}
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5" style={{ borderBottom: '1px solid var(--hairline)' }}>
      <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: 'var(--glass-strong)', border: '1px solid var(--hairline-strong)', color: 'var(--ink)' }}>
        {PILL[v.kind]}
      </span>
      <span className="min-w-0 flex-1" style={{ overflowWrap: 'anywhere' }}>
        <span className="font-mono text-[12px]" style={{ color: 'var(--ink)' }}>{v.name}</span>
        {v.note && (
          // Not a tooltip: "this .adf came out of a .dms" needs to be seen.
          <span className="ml-2 text-[11.5px]" data-testid="ingest-note" style={{ color: 'var(--muted)' }}>{v.note}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 font-mono text-[11.5px]" style={{ color: 'var(--muted)' }}>
        {v.size}
        {hd && <HdTag testId="ingest-hd-tag" />}
      </span>
      <span className="flex min-w-0 basis-full flex-wrap items-center gap-2">
        <span className="min-w-0 text-[12px]" style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }}>{v.where}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px]" data-testid={`staging-status-${v.key}`}
              style={{ color: v.tone === 'fail' ? 'var(--danger-fg)' : 'var(--ink)', overflowWrap: 'anywhere' }}>
          <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: DOT[v.tone] }} />
          {failNote ? <span>Failed · <span data-testid="ingest-note">{failNote}</span></span> : v.status}
        </span>
        {children}
      </span>
    </li>
  );
}
