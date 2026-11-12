'use client';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Link } from '@/components/shell/link';

const key = (id: string) => `wf-get-started-dismissed:${id}`;

function readDismissed(id: string): boolean {
  try { return window.localStorage.getItem(key(id)) === '1'; } catch { return false; }
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

/**
 * "Get started" (operator 2026-11-12): three steps on a new board's card, until its first disk (the card decides,
 * devices-look needsGetStarted) or until dismissed. Dismissed is per device, in this browser's localStorage; it is read
 * through useSyncExternalStore, so the server and the first client render both draw the block (no hydration mismatch)
 * and a dismissed one goes on the render after.
 */
export function GetStarted({ deviceId }: { deviceId: string }) {
  const stored = useSyncExternalStore(subscribe, () => readDismissed(deviceId), () => false);
  const [dismissed, setDismissed] = useState(false);
  if (stored || dismissed) return null;

  function dismiss() {
    try { window.localStorage.setItem(key(deviceId), '1'); } catch { /* private window: hidden until reload */ }
    setDismissed(true);
  }

  const steps: ReactNode[] = [
    <>Pick a game in the <Link href="/library" className="font-semibold underline" style={{ color: 'var(--ink)' }}>Library</Link></>,
    <>Press <strong style={{ color: 'var(--ink)' }}>Mount</strong></>,
    'Switch on your Amiga',
  ];
  return (
    <section aria-label="Get started" data-testid={`device-get-started-${deviceId}`}
             className="flex items-start gap-3 rounded-[14px] border px-4 py-3.5" style={{ borderColor: 'var(--line)' }}>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Get started</span>
        <ol className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-6">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--muted)' }}>
              <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-semibold"
                    style={{ background: 'var(--track)', color: 'var(--ink)' }}>{i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </div>
      <button type="button" onClick={dismiss} data-testid={`device-get-started-dismiss-${deviceId}`}
              aria-label="Dismiss Get started" title="Dismiss"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] hover:bg-[var(--track)] max-sm:size-11"
              style={{ color: 'var(--muted)' }}>
        <X aria-hidden className="size-4" />
      </button>
    </section>
  );
}
