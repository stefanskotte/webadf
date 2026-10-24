'use client';

import { useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { DEVICE_NAME_MAX } from '@/lib/device-name';
import { usePairing } from './pairing';

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const inkButton = 'h-10 rounded-[10px] px-4 text-[14px] font-semibold disabled:opacity-50';
const inkStyle = { background: 'var(--ink)', color: 'var(--surface)' } as const;

/**
 * Pair a device: first the board's name (plan 2026-10-17 R8 -- boards that all read "Device <MAC>" made every picker
 * ambiguous), then the code. The name is optional: left empty, the board wears its MAC as before and can be named on
 * its card later. The state lives in PairingProvider (spec §1.2), so the aside's button opens this same form.
 */
export function PairButton() {
  const p = usePairing();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (p.naming) input.current?.focus(); }, [p.naming]);

  if (p.code) {
    return (
      <div className="flex flex-col items-end gap-1 outline-none" data-testid="pairing-code" tabIndex={-1}>
        <span className="font-mono text-[20px] font-bold tracking-[0.14em]"
              style={{ color: 'var(--ink)' }}>{p.code}</span>
        {p.pairedName && (
          <span className="max-w-[60vw] text-right text-[12px]" data-testid="pairing-for"
                style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }}>for {p.pairedName}</span>
        )}
        <span className="text-[12px]" data-testid="pairing-expiry" style={{ color: 'var(--muted)' }}>
          {p.remainingMs === null ? 'enter this on the device' : `expires in ${formatRemaining(p.remainingMs)}`}
        </span>
      </div>
    );
  }

  if (p.naming) {
    return (
      <form className="flex flex-col items-end gap-1" onSubmit={(e) => { e.preventDefault(); void p.mint(); }}>
        <label className="flex flex-col items-end gap-1 text-[12px]" style={{ color: 'var(--muted)' }}>
          Name this board
          <input ref={input} value={p.name} maxLength={DEVICE_NAME_MAX} data-testid="pair-name"
                 onChange={(e) => p.setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Escape') p.cancelNaming(); }}
                 placeholder="e.g. A500 in the study"
                 className="h-10 w-[min(240px,60vw)] rounded-[10px] border px-3 text-[14px]"
                 style={{ borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--ink)' }} />
        </label>
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Leave it empty to name it by its MAC address.</span>
        <div className="flex gap-2">
          <button type="button" onClick={p.cancelNaming} data-testid="pair-cancel"
                  className="h-10 rounded-[10px] px-3 text-[14px] font-semibold" style={{ color: 'var(--muted)' }}>
            Cancel
          </button>
          <button type="submit" disabled={p.busy} data-testid="pair-submit" className={inkButton} style={inkStyle}>
            {p.busy ? 'Minting…' : 'Get a code'}
          </button>
        </div>
      </form>
    );
  }

  if (p.expired) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
          Code expired
        </span>
        <button type="button" onClick={() => void p.mint()} disabled={p.busy} data-testid="pair-device"
                className={inkButton} style={inkStyle}>
          {p.busy ? 'Minting…' : 'Mint a new code'}
        </button>
      </div>
    );
  }

  return (
    <button type="button" onClick={p.startNaming} data-testid="pair-device"
            className={`flex items-center gap-1.5 ${inkButton}`} style={inkStyle}>
      <Plus size={16} aria-hidden /> Pair a device
    </button>
  );
}
