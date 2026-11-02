'use client';
// The progress panel (spec 2026-11-01-progress-panel §3, §5, §6): every page's view of the org's running Files jobs.
// From lg bottom right; below it a full-width strip above the tab bar; lifted above anything marked
// data-transfers-anchor (the Files bar). Collapsed, a pill; open, one card per job, newest first. A region named
// "Transfers"; each bar a progressbar; a finished job is announced once, politely; Cancel asks first. z-30: a dialog
// (z-50) always covers it. Toasts sit above it (--transfers-top, read by the Toaster's offset).
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { isSignedOutAnswer, SIGNED_OUT_TEXT } from '@/lib/signed-out';
import {
  askingAbout, barOf, canCancel, cardShown, confirmWords, failureList, isClean, jobLine, jobNow, jobTitle, panelLift, pillWords, resultWords, timeLeft,
  type JobView, type Sample,
} from '@/lib/files/job-view';
import { useJobsState, useJobsStore } from './jobs-provider';

const CANCEL_FAILED = 'Could not cancel — try again.';

export function TransfersPanel() {
  const store = useJobsStore();
  const st = useJobsState();
  const [now, setNow] = useState(() => Date.now());
  const [lift, setLift] = useState(0);
  const [asking, setAsking] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const box = useRef<HTMLElement>(null);
  const seen = new Set(st.seen);
  const shown = st.jobs.filter((j) => cardShown(j, { finishedSeenAt: st.finishedSeenAt[j.id] ?? null, dismissed: seen.has(j.id), now }));
  const hasCards = shown.length > 0;
  // The dialog asks about the job as the store has it now, and goes once that job no longer runs.
  const ask = asking === null ? null : askingAbout(asking, st.jobs);

  // While cards show: the clock for the fade and the estimate, and where the panel sits (above an anchor on screen).
  useEffect(() => {
    if (!hasCards) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const tops = [...document.querySelectorAll('[data-transfers-anchor]')].map((el) => el.getBoundingClientRect())
          .filter((r) => r.height > 0).map((r) => r.top);
        setLift(panelLift(tops, window.innerHeight));
        const el = box.current;
        if (el) document.documentElement.style.setProperty('--transfers-top', `${Math.ceil(window.innerHeight - el.getBoundingClientRect().top + 8)}px`);
      });
    };
    const each = () => { const t = Date.now(); setNow(t); store.fadeFinished(t); measure(); };
    measure();
    const timer = window.setInterval(each, 1000);
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
      document.documentElement.style.removeProperty('--transfers-top');
    };
  }, [hasCards, store]);

  async function cancel(j: JobView) {
    setCancelling(true);
    try {
      const res = await fetch(`/api/files/jobs/${encodeURIComponent(j.id)}/cancel`, { method: 'POST' });
      if (isSignedOutAnswer(res)) toast.error(SIGNED_OUT_TEXT);
      else if (!res.ok) toast.error(CANCEL_FAILED);
    } catch {
      toast.error(CANCEL_FAILED);
    } finally {
      setCancelling(false);
      setAsking(null);
      store.poke();
    }
  }

  const pill = pillWords(shown);
  return (
    <>
      <p className="sr-only" aria-live="polite" data-testid="transfers-announce">{st.announce}</p>
      {hasCards && (
        <section ref={box} role="region" aria-label="Transfers" data-testid="transfers-panel"
                 className="fixed right-6 z-30 flex w-[360px] flex-col gap-2 max-lg:left-4 max-lg:right-4 max-lg:w-auto"
                 style={{ bottom: `max(var(--transfers-base), ${lift}px)` }}>
          <button type="button" data-testid="transfers-pill" aria-expanded={st.open} aria-controls="transfers-cards"
                  aria-label={`${st.open ? 'Hide' : 'Show'} transfers: ${pill}`} onClick={() => store.setOpen(!st.open)}
                  className="min-h-11 self-end rounded-full border px-4 text-[13px] font-medium shadow-sm focus-visible:outline-2 focus-visible:outline-(--ring) max-lg:self-stretch lg:min-h-9"
                  style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
            {pill}
          </button>
          <ul id="transfers-cards" data-testid="transfers-cards" hidden={!st.open}
              className="flex max-h-[min(60vh,480px)] flex-col gap-2 overflow-y-auto">
            {st.signedOut && (
              <li className="rounded-[14px] border p-3 text-[13px]" style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }}>
                {SIGNED_OUT_TEXT}
              </li>
            )}
            {shown.map((j) => (
              <JobCard key={j.id} j={j} samples={st.samples[j.id] ?? []} now={now} onCancel={() => setAsking(j.id)} onClose={() => store.dismiss(j.id)} />
            ))}
          </ul>
        </section>
      )}
      {ask && (
        <Modal open onOpenChange={(o) => { if (!o) setAsking(null); }} title="Cancel the rest?" width={440}
               testId="transfers-cancel-dialog" closeTestId="transfers-cancel-close" dismissible={!cancelling}
               footer={(
                 <>
                   <Button variant="destructive" data-testid="transfers-cancel-yes" disabled={cancelling} onClick={() => void cancel(ask)}>
                     Cancel the rest
                   </Button>
                   <Button variant="outline" data-testid="transfers-cancel-no" disabled={cancelling} onClick={() => setAsking(null)}>
                     Keep going
                   </Button>
                 </>
               )}>
          <p data-testid="transfers-cancel-text" className="px-6 py-4 text-[14px]" style={{ color: 'var(--ink)' }}>{confirmWords(ask)}</p>
        </Modal>
      )}
    </>
  );
}

function JobCard({ j, samples, now, onCancel, onClose }: { j: JobView; samples: Sample[]; now: number; onCancel(): void; onClose(): void }) {
  const title = jobTitle(j);
  const bar = barOf(j);
  const line2 = jobNow(j);
  const failures = failureList(j);
  return (
    <li data-testid="transfers-card" data-job-id={j.id} data-state={j.running ? 'running' : isClean(j) ? 'done' : 'kept'}
        className="rounded-[14px] border p-3 text-[13px] shadow-sm"
        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
      <div className="flex items-start gap-2">
        <p data-testid="transfers-card-title" className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{title}</p>
        {!j.running && (
          <button type="button" data-testid="transfers-close" aria-label={`Close: ${title}`} onClick={onClose}
                  className="-m-2 flex size-11 shrink-0 items-center justify-center rounded-[10px] hover:bg-[var(--track)] focus-visible:outline-2 focus-visible:outline-(--ring)"
                  style={{ color: 'var(--muted)' }}>
            <XIcon className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {j.running ? (
        <>
          <div role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar.value} data-testid="transfers-bar"
               className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
            <div className="h-full rounded-full transition-[width]" style={{ width: `${bar.value}%`, background: 'var(--ink)' }} />
          </div>
          <p data-testid="transfers-card-line" className="mt-1.5" style={{ color: 'var(--muted)' }}>{jobLine(j, timeLeft(samples, j, now))}</p>
          {line2 && <p data-testid="transfers-card-now" className="truncate" style={{ color: 'var(--muted)' }}>{line2}</p>}
          {canCancel(j) && (
            <Button size="sm" variant="outline" className="mt-2 max-lg:min-h-11" data-testid="transfers-cancel" onClick={onCancel}>
              Cancel the rest
            </Button>
          )}
        </>
      ) : (
        <>
          <p data-testid="transfers-card-result" className="mt-1 [overflow-wrap:anywhere]">{resultWords(j)}</p>
          {failures.length > 0 && (
            <ul data-testid="transfers-card-failures" className="mt-1 list-disc pl-5" style={{ color: 'var(--muted)' }}>
              {failures.map((f, k) => <li key={k} className="[overflow-wrap:anywhere]">{f}</li>)}
            </ul>
          )}
        </>
      )}
    </li>
  );
}
