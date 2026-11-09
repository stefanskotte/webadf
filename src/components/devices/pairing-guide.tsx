'use client';

import type { ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { PAIRING_CODE_MINUTES, SETUP_ADDRESS, SETUP_NETWORK, SETUP_PASSWORD } from '@/lib/pairing-guide';
import { usePairing } from './pairing';

/**
 * How pairing works (2026-11-09). Written from a tester's first setup in the WifiFloppy Discord thread: they started at
 * the board, whose setup page asks for a pairing code without saying it comes from this page; their phone did not open
 * the setup page by itself; and another tester's code ran out on slow Wi-Fi. So the steps start HERE, give the setup
 * page's address, and say what the board does after Save (joins the home Wi-Fi, then registers with this server using
 * the code; on failure its setup network comes back with the reason).
 *
 * Every fact is in src/lib/pairing-guide.ts beside its source. Shown in three places: the "How pairing works" dialog
 * (always reachable from the header, useful after the first board too), the empty Devices page, and under the header
 * while a code is live (with the code written into step 4).
 */

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono font-semibold" style={{ color: 'var(--ink)' }}>{children}</span>
);

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
            style={{ background: 'var(--ink)', color: 'var(--surface)' }}>{n}</span>
      <div className="min-w-0 text-[14px] leading-snug" style={{ color: 'var(--muted)' }}>
        <p className="font-semibold" style={{ color: 'var(--ink)' }}>{title}</p>
        <p style={{ overflowWrap: 'anywhere' }}>{children}</p>
      </div>
    </li>
  );
}

/** The five steps. With a live `code`, step 1 is done and the code is written into step 4. */
export function PairingSteps({ code, remainingMs }: { code?: string | null; remainingMs?: number | null }) {
  return (
    <ol className="flex flex-col gap-3.5" data-testid="pairing-steps">
      <Step n={1} title={code ? 'Code ready' : 'Get a pairing code here'}>
        {code
          ? <>Your code is <Mono>{code}</Mono>{remainingMs != null && <>, it expires in {formatRemaining(remainingMs)}</>}.</>
          : <>Press <em>Pair a device</em> on this page, name the board and press <em>Get a code</em>. The code lasts {PAIRING_CODE_MINUTES} minutes.</>}
      </Step>
      <Step n={2} title="Power the board">
        Its screen shows <em>Setup needed</em> and the name of its own Wi-Fi network, <Mono>{SETUP_NETWORK}</Mono>.
      </Step>
      <Step n={3} title="Join the board's network from a phone or laptop">
        Join <Mono>{SETUP_NETWORK}</Mono> with the password <Mono>{SETUP_PASSWORD}</Mono>. The setup page opens by
        itself; if it does not, open <Mono>{SETUP_ADDRESS}</Mono> in a browser.
      </Step>
      <Step n={4} title="Fill in the setup page">
        Enter your home Wi-Fi name and password, and the pairing code{code ? <> <Mono>{code}</Mono></> : ' from step 1'}.
        Press <em>Save</em>.
      </Step>
      <Step n={5} title="Wait about a minute">
        The board&apos;s network disappears, the board joins your Wi-Fi and uses the code to register with this
        server. It then appears on this page{code ? ' by itself' : ''}. If it cannot, its network comes back with the
        reason at the top of the setup page: join it again and fix that.
      </Step>
    </ol>
  );
}

/** The problems testers actually hit, each with what to do. */
export function PairingTrouble() {
  return (
    <div className="flex flex-col gap-1.5 text-[14px]" data-testid="pairing-trouble" style={{ color: 'var(--muted)' }}>
      <p className="font-semibold" style={{ color: 'var(--ink)' }}>Not working?</p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        <li><strong>No setup page after joining:</strong> open <Mono>{SETUP_ADDRESS}</Mono>. If that fails too, forget
          the board&apos;s network on the phone and join again, or use another phone or laptop.</li>
        <li><strong>The code expired:</strong> get a new one here and type that one instead.</li>
        <li><strong>The board cannot join your Wi-Fi:</strong> it needs a 2.4 GHz network with a password (5 GHz-only
          and open networks do not work). The name and password are case-sensitive.</li>
        <li><strong>A board paired before:</strong> it offers its setup network again once it is deleted here, or when
          it cannot reach its Wi-Fi.</li>
      </ul>
    </div>
  );
}

/** The header's "How pairing works": opens the guide, whether or not a board is paired yet. */
export function PairingGuideButton({ className = '' }: { className?: string }) {
  const { setGuideOpen } = usePairing();
  return (
    <button type="button" data-testid="pairing-guide-open" onClick={() => setGuideOpen(true)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[14px] font-semibold underline-offset-2 hover:underline max-sm:min-h-11 ${className}`}
            style={{ color: 'var(--muted)' }}>
      <CircleHelp size={16} aria-hidden /> How pairing works
    </button>
  );
}

export function PairingGuideDialog() {
  const { guideOpen, setGuideOpen, code, remainingMs } = usePairing();
  return (
    <Modal open={guideOpen} onOpenChange={setGuideOpen} width={620} testId="pairing-guide" closeTestId="pairing-guide-close"
           dismissible title="How pairing works"
           subtitle="Pairing links a board to this account. You do it once per board."
           footer={(
             <div className="flex justify-end">
               <button type="button" onClick={() => setGuideOpen(false)}
                       className="h-10 rounded-[10px] px-4 text-[14px] font-semibold"
                       style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
                 Close
               </button>
             </div>
           )}>
      <div className="flex flex-col gap-5 px-6 py-5">
        <PairingSteps code={code} remainingMs={remainingMs} />
        <PairingTrouble />
      </div>
    </Modal>
  );
}

/**
 * Under the header while a code is live: the steps with the code in them, so nobody holds a code without knowing where
 * it goes. After the board registers, a short "Paired" line instead.
 */
export function PairingPanel() {
  const { code, remainingMs, paired } = usePairing();
  if (!code && paired === null) return null;
  return (
    <section data-testid="pairing-panel" aria-live="polite"
             className="flex flex-col gap-5 rounded-[20px] border p-5 sm:p-6"
             style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
      {code ? (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-[18px] font-bold" style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>
              Now set up the board
            </p>
            <p className="text-[14px]" style={{ color: 'var(--muted)' }}>
              Keep this page open: it shows the board as soon as it registers.
            </p>
          </div>
          <PairingSteps code={code} remainingMs={remainingMs} />
          <PairingTrouble />
        </>
      ) : (
        <p data-testid="pairing-done" className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>
          {paired ? `Paired: ${paired}.` : 'Board paired.'} It is listed below.
        </p>
      )}
    </section>
  );
}
