'use client';

import { PairAnotherButton, usePairing } from './pairing';
import { PairingSteps } from './pairing-guide';

/**
 * The page with no devices (spec 9.1): the drive outline first, then the words, then the pairing button. Since
 * 2026-11-09 the five pairing steps sit between the words and the button (a tester's first setup stalled on not
 * knowing the code comes from this page). While a code is live the card is not drawn: the panel above carries the
 * steps with the code in them.
 */
export function DevicesEmpty() {
  const { code } = usePairing();
  // While a code is live the panel above is the whole story (steps, code, what to do when stuck): an empty card under
  // it would only repeat "No devices paired yet".
  if (code) return null;
  return (
    <div data-testid="devices-empty" data-empty="devices"
         className="flex flex-col items-center gap-3.5 rounded-[20px] px-8 py-16 text-center max-sm:px-5"
         style={{ background: 'var(--surface)', border: '1px dashed var(--line-strong)' }}>
      <svg width="120" height="52" viewBox="0 0 120 52" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="118" height="50" rx="8" stroke="#C4B9A2" strokeWidth="1.5" strokeDasharray="5 4" />
        <rect x="22" y="30" width="76" height="8" rx="3" style={{ fill: 'var(--line-strong)' }} />
      </svg>
      <p className="text-[22px] font-bold" style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>No devices paired yet</p>
      <p className="text-[14px]" style={{ color: 'var(--muted)' }}>Pairing links a board to this account. It takes five steps.</p>
      <div className="my-2 w-full max-w-[520px] text-left">
        <PairingSteps />
      </div>
      <PairAnotherButton />
    </div>
  );
}
