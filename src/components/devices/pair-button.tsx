'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function PairButton() {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  // Ticks the countdown once a second while a code is live. This is the only
  // thing that decides whether the code stays on screen -- once remainingMs
  // hits 0 the code is server-side dead, and the effect below drops it.
  useEffect(() => {
    if (expiresAt === null) return;
    const tick = () => setRemainingMs(Math.max(0, expiresAt - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // A code that has hit zero is worse to leave on screen than no code at
  // all -- it sends someone to the hardware to type something that fails --
  // so it is removed here rather than left disabled or greyed out.
  useEffect(() => {
    if (code !== null && remainingMs === 0) {
      setCode(null);
      setExpiresAt(null);
      setExpired(true);
    }
  }, [code, remainingMs]);

  async function onClick() {
    setBusy(true);
    setExpired(false);
    try {
      // fetch itself rejects on a network failure (offline, DNS, aborted) --
      // before there is any Response to check `.ok` on. Without this inner
      // try/catch that rejection is unhandled and the button silently snaps
      // back with nothing on screen.
      let res: Response;
      try {
        res = await fetch('/api/devices/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'New device' }),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
        return;
      }
      if (!res.ok) {
        toast.error('Could not mint a pairing code', { description: `The server answered ${res.status}.` });
        return;
      }
      const body = await res.json();
      const expiresAtMs = new Date(body.expiresAt).getTime();
      setCode(body.code);
      setExpiresAt(expiresAtMs);
      setRemainingMs(expiresAtMs - Date.now());
    } finally {
      setBusy(false);
    }
  }

  if (code) {
    return (
      <div className="flex flex-col items-end gap-1" data-testid="pairing-code">
        <span className="font-mono text-[20px] font-bold tracking-[0.14em]"
              style={{ color: 'var(--on-dark)' }}>{code}</span>
        <span className="text-[11px]" data-testid="pairing-expiry" style={{ color: 'var(--on-dark-muted)' }}>
          {remainingMs === null ? 'enter this on the device' : `expires in ${formatRemaining(remainingMs)}`}
        </span>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-[11px]" style={{ color: 'var(--on-dark-muted)' }}>
          Code expired
        </span>
        <button type="button" onClick={onClick} disabled={busy} data-testid="pair-device"
                className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
                style={{ background: 'var(--primary-action)' }}>
          {busy ? 'Minting…' : 'Mint a new code'}
        </button>
      </div>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={busy} data-testid="pair-device"
            className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--primary-action)' }}>
      {busy ? 'Minting…' : 'Pair a device'}
    </button>
  );
}
