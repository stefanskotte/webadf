'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import {
  canDeleteShare, revokeConfirmText, shareDate, shareScopeText, shareStatusText, type ShareView,
} from '@/lib/share/view';
import { CARD_STYLE, FIELD, FIELD_STYLE, INK_BTN, INK_STYLE, OUTLINE_BTN, OUTLINE_STYLE, SETTINGS_CARD, SETTINGS_H2 } from '@/lib/settings-look';

type Collection = { id: string; name: string };
type Reach = { ok: boolean; origin: string; detail?: string };
type Dialog =
  | { kind: 'new' }
  | { kind: 'created'; share: ShareView; link: string; pinProblem?: string }
  | { kind: 'edit'; share: ShareView }
  | { kind: 'revoke'; share: ShareView }
  | null;

const ERRORS: Record<string, string> = {
  bad_label: 'Give the share a name, up to 60 characters.',
  no_scope: 'Pick Everything or at least one collection.',
  bad_collection: 'One of those collections no longer exists. Reload and try again.',
  not_found: 'That share no longer exists. Reload the page.',
  not_deletable: 'Only revoked or expired shares can be deleted.',
};

/** fetch + JSON, with the session-expired redirect (fetch follows it to a 200 HTML page) turned into an error. */
async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init);
    if (res.redirected || !res.headers.get('content-type')?.includes('application/json')) {
      return { ok: false, error: 'Your session expired. Sign in again and retry.' };
    }
    const body = await res.json() as T & { error?: string };
    if (!res.ok) return { ok: false, error: ERRORS[body.error ?? ''] ?? `Something went wrong (the server answered ${res.status}).` };
    return { ok: true, body };
  } catch {
    return { ok: false, error: 'Could not reach the server. Nothing was changed.' };
  }
}
const json = (method: string, body?: unknown): RequestInit =>
  ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * Settings > Sharing (spec §3.4): who this library is shared with. A share is a one-time link the owner sends; the
 * other person's WebFloppy claims it and then browses the shared collections. The link exists only in the answer to
 * New share (the server keeps a hash), so the dialog shows it once, with Copy.
 */
export function SharingSettings({ initialShares, collections }: { initialShares: ShareView[]; collections: Collection[] }) {
  const [shares, setShares] = useState(initialShares);
  const [reach, setReach] = useState<Reach | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = new Map(collections.map((c) => [c.id, c.name]));
  const newBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    void call<Reach>('/api/shares/reachability').then((r) => {
      if (!live) return;
      setReach(r.ok ? r.body : { ok: false, origin: '', detail: r.error });
    });
    return () => { live = false; };
  }, []);

  async function reload() {
    const r = await call<{ shares: ShareView[] }>('/api/shares');
    if (r.ok) setShares(r.body.shares);
  }

  function close() {
    if (busy) return;
    setDialog(null);
    setError(null);
  }

  async function run(url: string, init: RequestInit, done: string) {
    setBusy(true);
    setError(null);
    const r = await call<{ ok: true }>(url, init);
    setBusy(false);
    if (!r.ok) { setError(r.error); return false; }
    toast.success(done);
    await reload();
    return true;
  }

  async function remove(s: ShareView) {
    const r = await call<{ ok: true }>(`/api/shares/${s.id}`, json('DELETE'));
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`${s.label} removed from the list.`);
    await reload();
  }

  return (
    <section id="sharing" aria-labelledby="sharing-heading" data-testid="sharing-settings" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-[3px]">
            <h2 id="sharing-heading" tabIndex={-1} className={`${SETTINGS_H2} justify-self-start`} style={{ color: 'var(--ink)' }}>
              Sharing
            </h2>
            <p className="text-[13px]" style={{ color: 'var(--muted-2)' }}>
              Let a friend&apos;s WebFloppy browse and mount your collections. Each link works once.
            </p>
          </div>
          <button ref={newBtn} type="button" data-testid="sharing-new" onClick={() => setDialog({ kind: 'new' })}
                  className={INK_BTN} style={INK_STYLE}>
            New share…
          </button>
        </div>

        <ReachLine reach={reach} />

        {shares.length === 0 ? (
          <p data-testid="sharing-empty" className="text-[13px]" style={{ color: 'var(--muted)' }}>
            Nothing shared yet.
          </p>
        ) : (
          <div className="-mx-1 overflow-x-auto px-1">
            <table data-testid="sharing-table" className="w-full min-w-[640px] border-collapse text-left text-[13px]" style={{ color: 'var(--ink)' }}>
              <thead>
                <tr className="border-b text-[12px] font-semibold" style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>
                  <th scope="col" className="py-2 pr-3">Person</th>
                  <th scope="col" className="py-2 pr-3">Collections</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2 pr-3">Last used</th>
                  <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shares.map((s) => (
                  <tr key={s.id} data-testid="sharing-row" data-share-id={s.id} data-status={s.status}
                      className="border-b align-top" style={{ borderColor: 'var(--line)' }}>
                    <td className="py-2.5 pr-3 font-medium [overflow-wrap:anywhere]">{s.label}</td>
                    <td className="py-2.5 pr-3 [overflow-wrap:anywhere]" data-testid="sharing-scope">{shareScopeText(s, names)}</td>
                    <td className="py-2.5 pr-3 [overflow-wrap:anywhere]" data-testid="sharing-status"
                        style={{ color: s.status === 'revoked' || s.status === 'expired' ? 'var(--muted)' : undefined }}>
                      {shareStatusText(s)}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">{s.lastUsedAt ? shareDate(s.lastUsedAt) : 'Never'}</td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {s.status !== 'revoked' && (
                          <>
                            <button type="button" data-testid="sharing-edit" aria-label={`Edit collections shared with ${s.label}`}
                                    onClick={() => setDialog({ kind: 'edit', share: s })} className={OUTLINE_BTN} style={OUTLINE_STYLE}>
                              Edit collections…
                            </button>
                            <button type="button" data-testid="sharing-revoke" aria-label={`Revoke ${s.label}'s access`}
                                    onClick={() => setDialog({ kind: 'revoke', share: s })} className={OUTLINE_BTN}
                                    style={{ ...OUTLINE_STYLE, color: 'var(--danger-fg)', borderColor: 'var(--danger-line)' }}>
                              Revoke…
                            </button>
                          </>
                        )}
                        {canDeleteShare(s.status) && (
                          <button type="button" data-testid="sharing-delete" aria-label={`Delete ${s.label} from the list`}
                                  onClick={() => void remove(s)} className={OUTLINE_BTN} style={OUTLINE_STYLE}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(dialog?.kind === 'new' || dialog?.kind === 'edit') && (
        <ScopeDialog
          key={dialog.kind === 'edit' ? dialog.share.id : 'new'}
          mode={dialog.kind}
          share={dialog.kind === 'edit' ? dialog.share : null}
          collections={collections}
          busy={busy}
          error={error}
          onClose={close}
          finalFocus={newBtn}
          onSubmit={async (v) => {
            if (dialog.kind === 'edit') {
              if (await run(`/api/shares/${dialog.share.id}`, json('PATCH', { everything: v.everything, collectionIds: v.collectionIds }),
                `Updated what ${dialog.share.label} can see.`)) setDialog(null);
              return;
            }
            setBusy(true);
            setError(null);
            const r = await call<{ share: ShareView; link: string; pinProblem?: string }>('/api/shares', json('POST', v));
            setBusy(false);
            if (!r.ok) { setError(r.error); return; }
            setDialog({ kind: 'created', ...r.body });
            await reload();
          }}
        />
      )}

      {dialog?.kind === 'created' && (
        <CreatedDialog share={dialog.share} link={dialog.link} pinProblem={dialog.pinProblem} onClose={close} finalFocus={newBtn} />
      )}

      {dialog?.kind === 'revoke' && (
        <Modal open onOpenChange={(o) => { if (!o) close(); }} width={440} testId="sharing-revoke-dialog"
               closeTestId="sharing-revoke-close" title={`Revoke ${dialog.share.label}?`} dismissible={!busy}
               finalFocus={newBtn}
               footer={(
                 <div className="flex w-full items-center justify-end gap-2.5">
                   <button type="button" aria-disabled={busy || undefined} onClick={close} className={OUTLINE_BTN} style={OUTLINE_STYLE}>
                     Cancel
                   </button>
                   <button type="button" data-testid="sharing-revoke-confirm" aria-disabled={busy || undefined}
                           onClick={async () => {
                             if (busy) return;
                             if (await run(`/api/shares/${dialog.share.id}/revoke`, json('POST'), `${dialog.share.label} no longer has access.`)) setDialog(null);
                           }}
                           className={INK_BTN} style={{ ...INK_STYLE, background: 'var(--danger-fg)' }}>
                     {busy ? 'Revoking…' : 'Revoke'}
                   </button>
                 </div>
               )}>
          <div className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--ink)' }}>
            <p data-testid="sharing-revoke-text">{revokeConfirmText(dialog.share.label)}</p>
            {error && <p role="alert" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</p>}
          </div>
        </Modal>
      )}
    </section>
  );
}

function ReachLine({ reach }: { reach: Reach | null }) {
  if (!reach) {
    return <p data-testid="sharing-reach" data-state="checking" className="text-[13px]" style={{ color: 'var(--muted)' }}>Checking whether other servers can reach this one…</p>;
  }
  if (reach.ok) {
    return (
      <p data-testid="sharing-reach" data-state="ok" className="text-[13px]" style={{ color: 'var(--success-fg)' }}>
        Your WebFloppy is reachable at <span className="font-mono [overflow-wrap:anywhere]">{reach.origin}</span> ✓
      </p>
    );
  }
  return (
    <p data-testid="sharing-reach" data-state="failed" role="status" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>
      Other servers can&apos;t reach <span className="font-mono [overflow-wrap:anywhere]">{reach.origin || 'this server'}</span>
      {reach.detail ? <>: <span className="[overflow-wrap:anywhere]">{reach.detail}</span></> : null}.{' '}
      <Link href="/help#sharing" className="underline" style={{ color: 'var(--ink)' }}>What to check</Link>
    </p>
  );
}

function ScopeDialog({
  mode, share, collections, busy, error, onClose, onSubmit, finalFocus,
}: {
  mode: 'new' | 'edit';
  share: ShareView | null;
  collections: Collection[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (v: { label: string; everything: boolean; collectionIds: string[] }) => Promise<void>;
  finalFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const [label, setLabel] = useState(share?.label ?? '');
  const [everything, setEverything] = useState(share?.everything ?? false);
  const [picked, setPicked] = useState<Set<string>>(new Set(share?.collectionIds ?? []));
  const labelId = useId();
  const formId = useId();
  const first = useRef<HTMLInputElement>(null);
  const ready = (mode === 'edit' || label.trim().length > 0) && (everything || picked.size > 0);

  function toggle(id: string) {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  return (
    <Modal open onOpenChange={(o) => { if (!o) onClose(); }} width={440}
           testId={mode === 'new' ? 'sharing-new-dialog' : 'sharing-edit-dialog'}
           closeTestId="sharing-dialog-close"
           title={mode === 'new' ? 'New share' : `What ${share?.label} can see`}
           subtitle={mode === 'new' ? 'Who is it for, and what may they see?' : undefined}
           dismissible={!busy} initialFocus={first} finalFocus={finalFocus}
           footer={(
             <div className="flex w-full items-center justify-end gap-2.5">
               <button type="button" aria-disabled={busy || undefined} onClick={onClose} className={OUTLINE_BTN} style={OUTLINE_STYLE}>Cancel</button>
               <button type="submit" form={formId} data-testid="sharing-save" disabled={!ready} aria-disabled={busy || undefined}
                       className={INK_BTN} style={INK_STYLE}>
                 {busy ? 'Saving…' : mode === 'new' ? 'Make link' : 'Save'}
               </button>
             </div>
           )}>
      <form id={formId} className="flex flex-col gap-4 px-6 py-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ready || busy) return;
              void onSubmit({ label: label.trim(), everything, collectionIds: everything ? [] : [...picked] });
            }}>
        {mode === 'new' && (
          <label htmlFor={labelId} className="flex flex-col gap-1.5 text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
            Person
            <input id={labelId} ref={first} data-testid="sharing-label" value={label} maxLength={60}
                   placeholder="Rob" onChange={(e) => setLabel(e.target.value)} className={FIELD} style={FIELD_STYLE} />
          </label>
        )}
        <fieldset className="flex flex-col gap-2 text-[14px]" style={{ color: 'var(--ink)' }}>
          <legend className="mb-1.5 text-[13px] font-medium">Collections</legend>
          <label className="flex items-center gap-2.5">
            <input type="checkbox" data-testid="sharing-everything" checked={everything}
                   ref={mode === 'edit' ? first : undefined}
                   onChange={(e) => setEverything(e.target.checked)} className="size-4" />
            Everything, including disks added later
          </label>
          {collections.length === 0 && !everything && (
            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>You have no collections yet; share Everything or make one first.</p>
          )}
          {collections.map((c) => (
            <label key={c.id} className="flex items-center gap-2.5" style={{ opacity: everything ? 0.55 : 1 }}>
              <input type="checkbox" data-testid="sharing-collection" data-collection-id={c.id}
                     checked={everything || picked.has(c.id)} disabled={everything}
                     onChange={() => toggle(c.id)} className="size-4" />
              <span className="[overflow-wrap:anywhere]">{c.name}</span>
            </label>
          ))}
        </fieldset>
        {error && <p role="alert" data-testid="sharing-error" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</p>}
      </form>
    </Modal>
  );
}

function CreatedDialog({
  share, link, pinProblem, onClose, finalFocus,
}: { share: ShareView; link: string; pinProblem?: string; onClose: () => void; finalFocus: React.RefObject<HTMLButtonElement | null> }) {
  const copyRef = useRef<HTMLButtonElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy', { description: 'The browser refused clipboard access. Select the link instead.' });
    }
  }
  return (
    <Modal open onOpenChange={(o) => { if (!o) onClose(); }} width={440} testId="sharing-created-dialog"
           closeTestId="sharing-created-close" title={`Link for ${share.label}`} dismissible initialFocus={copyRef}
           finalFocus={finalFocus}
           footer={(
             <div className="flex w-full items-center justify-end gap-2.5">
               <button type="button" onClick={onClose} className={INK_BTN} style={INK_STYLE}>Done</button>
             </div>
           )}>
      <div className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--ink)' }}>
        <p>Send this link to {share.label}. This is the only time it is shown.</p>
        <div className="flex items-stretch gap-2">
          <input readOnly value={link} data-testid="sharing-link" aria-label="Share link" onFocus={(e) => e.currentTarget.select()}
                 className={`${FIELD} font-mono text-[12px]`} style={FIELD_STYLE} />
          <button ref={copyRef} type="button" data-testid="sharing-copy" onClick={() => void copy()} className={OUTLINE_BTN} style={OUTLINE_STYLE}>
            Copy
          </button>
        </div>
        <p data-testid="sharing-expiry" className="text-[13px]" style={{ color: 'var(--muted)' }}>
          It works once. Unclaimed links expire on {shareDate(share.claimExpiresAt)}.
        </p>
        {pinProblem && (
          <p role="status" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>
            This server&apos;s certificate could not be read ({pinProblem}), so the link carries no pin and may not work for
            others. See <Link href="/help#sharing" className="underline">Help</Link>.
          </p>
        )}
      </div>
    </Modal>
  );
}
