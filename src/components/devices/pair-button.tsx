'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DEVICE_NAME_MAX } from '@/lib/device-name';

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Pair a device: first the board's name (plan 2026-10-17 R8 -- boards that all read "Device <MAC>" made every picker
 * ambiguous), then the code. The name is optional: left empty, the board wears its MAC as before and can be named on
 * its card later.
 */
export function PairButton() {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [pairedName, setPairedName] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (naming) input.current?.focus(); }, [naming]);

  // Ticks the countdown once a second while a code is live (as before).
  useEffect(() => {
    if (expiresAt === null) return;
    const tick = () => setRemainingMs(Math.max(0, expiresAt - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // A code that has hit zero is removed rather than left greyed out (as before).
  useEffect(() => {
    if (code !== null && remainingMs === 0) {
      setCode(null);
      setExpiresAt(null);
      setExpired(true);
    }
  }, [code, remainingMs]);

  async function mint() {
    setBusy(true);
    setExpired(false);
    const typed = name.trim();
    try {
      let res: Response;
      try {
        res = await fetch('/api/devices/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(typed ? { name: typed } : {}),
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
      setPairedName(typed || null);
      setNaming(false);
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
        {pairedName && (
          <span className="max-w-[60vw] text-right text-[11px]" data-testid="pairing-for"
                style={{ color: 'var(--on-dark-muted)', overflowWrap: 'anywhere' }}>for {pairedName}</span>
        )}
        <span className="text-[11px]" data-testid="pairing-expiry" style={{ color: 'var(--on-dark-muted)' }}>
          {remainingMs === null ? 'enter this on the device' : `expires in ${formatRemaining(remainingMs)}`}
        </span>
      </div>
    );
  }

  if (naming) {
    return (
      <form className="flex flex-col items-end gap-1" onSubmit={(e) => { e.preventDefault(); void mint(); }}>
        <label className="flex flex-col items-end gap-1 text-[11px]" style={{ color: 'var(--on-dark-muted)' }}>
          Name this board
          <input ref={input} value={name} maxLength={DEVICE_NAME_MAX} data-testid="pair-name"
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Escape') setNaming(false); }}
                 placeholder="e.g. A500 in the study"
                 className="w-[min(240px,60vw)] rounded-lg border bg-transparent px-2 py-1 text-[12.5px]"
                 style={{ borderColor: 'var(--hairline-strong)', color: 'var(--on-dark)' }} />
        </label>
        <span className="text-[10.5px]" style={{ color: 'var(--on-dark-muted)' }}>Leave it empty to name it by its MAC address.</span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setNaming(false)} data-testid="pair-cancel"
                  className="rounded-lg px-3 py-2 text-[12.5px] font-semibold" style={{ color: 'var(--on-dark)' }}>
            Cancel
          </button>
          <button type="submit" disabled={busy} data-testid="pair-submit"
                  className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
                  style={{ background: 'var(--primary-action)' }}>
            {busy ? 'Minting…' : 'Get a code'}
          </button>
        </div>
      </form>
    );
  }

  if (expired) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-[11px]" style={{ color: 'var(--on-dark-muted)' }}>
          Code expired
        </span>
        <button type="button" onClick={() => void mint()} disabled={busy} data-testid="pair-device"
                className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
                style={{ background: 'var(--primary-action)' }}>
          {busy ? 'Minting…' : 'Mint a new code'}
        </button>
      </div>
    );
  }

  return (
    <button type="button" onClick={() => { setName(''); setNaming(true); }} data-testid="pair-device"
            className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white"
            style={{ background: 'var(--primary-action)' }}>
      Pair a device
    </button>
  );
}
