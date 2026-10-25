import { PairAnotherButton } from './pairing';

/** The page with no devices (spec 9.1): the drive outline first, then the words, then the pairing button. */
export function DevicesEmpty() {
  return (
    <div data-testid="devices-empty" data-empty="devices"
         className="flex flex-col items-center gap-3.5 rounded-[20px] px-8 py-16 text-center"
         style={{ background: 'var(--surface)', border: '1px dashed var(--line-strong)' }}>
      <svg width="120" height="52" viewBox="0 0 120 52" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="118" height="50" rx="8" stroke="#C4B9A2" strokeWidth="1.5" strokeDasharray="5 4" />
        <rect x="22" y="30" width="76" height="8" rx="3" style={{ fill: 'var(--line-strong)' }} />
      </svg>
      <p className="text-[22px] font-bold" style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>No devices paired yet</p>
      <p className="text-[14px]" style={{ color: 'var(--muted)' }}>Press Pair a device and enter the code on the board.</p>
      <PairAnotherButton />
    </div>
  );
}
