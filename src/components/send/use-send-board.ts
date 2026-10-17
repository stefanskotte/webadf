'use client';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { pickTarget, SEND_BOARD_KEY, type SendTarget } from '@/lib/send-ui';

// The board files are sent to (spec §4: "the last choice remembered in the browser"). One choice for every Send
// control on every page, kept in localStorage and announced in-page, so the disk pages' picker and their Send
// buttons agree. Browser storage can throw (private windows); it then falls back to the first target.
const EVENT = 'webadf:send-board';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(EVENT, onChange);
  return () => { window.removeEventListener('storage', onChange); window.removeEventListener(EVENT, onChange); };
}
function readStored(): string | null {
  try { return window.localStorage.getItem(SEND_BOARD_KEY); } catch { return null; }
}

export function useSendBoard(targets: SendTarget[], now: number, initial: string | null = null): [string | null, (id: string) => void] {
  const stored = useSyncExternalStore(subscribe, readStored, () => null);
  const [chosen, setChosen] = useState<string | null>(initial);
  const id = pickTarget(targets, chosen ?? stored, now);
  const set = useCallback((v: string) => {
    setChosen(v);
    try { window.localStorage.setItem(SEND_BOARD_KEY, v); } catch { /* not remembered; this page still uses it */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [id, set];
}
