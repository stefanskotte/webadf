'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link } from '@/components/shell/link';
import { remoteErrorText } from '@/lib/remote/copy';
import { addConfirmText, shareLinkHost } from '@/lib/remote/view';
import { CARD_STYLE, FIELD, FIELD_STYLE, INK_BTN, INK_STYLE, SETTINGS_CARD } from '@/lib/settings-look';

type Failure = { text: string; existing: boolean };

/**
 * Add a shared library (spec §4.2 Add): paste the link the owner sent, or arrive from their landing page at
 * `/remote/add#link=<link>`. An arrived link only fills the field and asks "Add the library shared from <host>?":
 * nothing is claimed until the person presses Add (controller ruling, Task 9 fix 1), so another site cannot add a
 * library to this team, or make this server contact a host of its choosing, just by linking here. The server parses
 * (whitespace, a trailing slash and the wrapped `/remote/add#link=` address all work), claims, and answers the id.
 */
export function AddRemoteForm() {
  const router = useRouter();
  const id = useId();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function add(raw: string) {
    if (busy || raw.trim() === '') return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch('/api/remote', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: raw }),
      });
      if (res.redirected || !res.headers.get('content-type')?.includes('application/json')) {
        setFailure({ text: 'Your session expired. Sign in again and retry.', existing: false });
        return;
      }
      const body = await res.json() as { id?: string; error?: string; host?: string | null; detail?: string };
      if (res.ok && body.id) {
        router.push(`/remote/${encodeURIComponent(body.id)}`);
        return;
      }
      setFailure({ text: remoteErrorText(body.error, body.host ?? null, body.detail), existing: body.error === 'already_added' });
    } catch {
      setFailure({ text: 'Could not reach the server. Nothing was added.', existing: false });
    } finally {
      setBusy(false);
    }
  }

  // On arrival (and when the address's fragment changes): the owner's landing page sends people here with the link
  // in the fragment, which the browser never sends to a server. The link is put in the field and taken out of the
  // address bar (a second run of this effect is then a no-op); the person decides whether to add it.
  useEffect(() => {
    const arrive = () => {
      const hash = window.location.hash;
      if (!hash.startsWith('#link=')) return;
      let inner = hash.slice('#link='.length);
      try { inner = decodeURIComponent(inner); } catch { /* shown as it is: the server says it is not a link */ }
      window.history.replaceState(null, '', window.location.pathname);
      // After this effect, not inside it (a state change in an effect body re-renders at once).
      void Promise.resolve().then(() => { setFailure(null); setLink(inner); });
    };
    arrive();
    window.addEventListener('hashchange', arrive);
    return () => window.removeEventListener('hashchange', arrive);
  }, []);

  const host = shareLinkHost(link);

  return (
    <form data-testid="remote-add-form" className={`${SETTINGS_CARD} flex max-w-[640px] flex-col gap-4`} style={CARD_STYLE}
          onSubmit={(e) => { e.preventDefault(); void add(link); }}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Share link</label>
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
          The link someone sent you from their WebFloppy. It works once: after adding, their library is listed under
          Remote for everyone on your team.
        </p>
      </div>
      <input id={id} data-testid="remote-add-link" value={link} onChange={(e) => setLink(e.target.value)}
             placeholder="https://their-webfloppy.example/s/…" autoComplete="off" spellCheck={false}
             className={`${FIELD} font-mono text-[13px]`} style={FIELD_STYLE} />
      {host && (
        <p data-testid="remote-add-confirm" className="text-[14px] font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
          {addConfirmText(host)}
        </p>
      )}
      {failure && (
        <p role="alert" data-testid="remote-add-error" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>
          {failure.text}
          {failure.existing && <> <Link href="/remote" className="font-semibold underline-offset-4 hover:underline">Open Remote</Link></>}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" data-testid="remote-add-submit" aria-disabled={busy || link.trim() === '' || undefined}
                className={INK_BTN} style={INK_STYLE}>
          {busy ? 'Adding…' : 'Add library'}
        </button>
        <Link href="/remote" className="text-[13px] font-medium" style={{ color: 'var(--muted)' }}>Cancel</Link>
      </div>
    </form>
  );
}
