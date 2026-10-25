'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

/**
 * The pairing state, shared by the header's Pair a device button and the "Add another drive" aside's button (spec
 * §1.2, Ruling 32): one form and one code at a time, so two codes can never be live from one page. The page wraps
 * the header and the list in the provider; `PairButton` draws the form, `PairAnotherButton` only asks it to open.
 */
export type PairingState = {
  naming: boolean;
  name: string;
  pairedName: string | null;
  code: string | null;
  remainingMs: number | null;
  expired: boolean;
  busy: boolean;
  setName: (v: string) => void;
  /** Open the naming form from a clean field. */
  startNaming: () => void;
  cancelNaming: () => void;
  mint: () => Promise<void>;
};

const PairingContext = createContext<PairingState | null>(null);

export function usePairing(): PairingState {
  const v = useContext(PairingContext);
  if (!v) throw new Error('usePairing needs a PairingProvider');
  return v;
}

export function PairingProvider({ children }: { children: React.ReactNode }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [pairedName, setPairedName] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  // Ticks the countdown once a second while a code is live. A code that has hit zero is removed rather than left
  // greyed out. (mint() sets the first remainingMs, so nothing is set synchronously here.)
  useEffect(() => {
    if (expiresAt === null) return;
    const id = setInterval(() => {
      const left = Math.max(0, expiresAt - Date.now());
      setRemainingMs(left);
      if (left === 0) {
        setCode(null);
        setExpiresAt(null);
        setExpired(true);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const mint = useCallback(async () => {
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
  }, [name]);

  const startNaming = useCallback(() => { setName(''); setNaming(true); }, []);
  const cancelNaming = useCallback(() => setNaming(false), []);

  const value = useMemo<PairingState>(() => ({
    naming, name, pairedName, code, remainingMs, expired, busy, setName, startNaming, cancelNaming, mint,
  }), [naming, name, pairedName, code, remainingMs, expired, busy, startNaming, cancelNaming, mint]);

  return <PairingContext.Provider value={value}>{children}</PairingContext.Provider>;
}

/**
 * The "Pair a device" button of the Add another drive aside and the empty state (spec §1.4, §9.1): a secondary 38 px
 * button that opens the header's form and brings the header into view. It draws no form of its own.
 */
export function PairAnotherButton() {
  const { startNaming, code } = usePairing();
  return (
    <button type="button" data-testid="pair-another"
            onClick={() => {
              // A code is already live (one at a time): bring it into view and focus it rather than do nothing.
              if (code) {
                const live = document.querySelector<HTMLElement>('[data-testid="pairing-code"]');
                live?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                live?.focus({ preventScroll: true });
                return;
              }
              startNaming();
              // The form is in the header; on a tall page it may be off screen.
              document.querySelector('[data-testid="pair-device"], [data-testid="pair-name"]')
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }}
            className="h-[38px] rounded-[10px] border px-4 text-[14px] font-semibold"
            style={{ background: 'var(--surface)', borderColor: 'var(--line-strong)', color: 'var(--ink)' }}>
      Pair a device
    </button>
  );
}
