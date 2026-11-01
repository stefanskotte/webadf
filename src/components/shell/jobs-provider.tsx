'use client';
// The jobs store for every page (spec 2026-11-01-progress-panel §3): one per app layout, started on mount, asking
// GET /api/files/jobs as jobs-client.ts decides. The panel reads it; Files tells it about the jobs it starts.
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { createJobsStore, type JobsAnswer, type JobsState, type JobsStore } from '@/lib/files/jobs-client';
import { isSignedOutAnswer } from '@/lib/signed-out';

const JobsContext = createContext<JobsStore | null>(null);

async function loadJobs(): Promise<JobsAnswer | 'signed-out' | null> {
  let res: Response;
  try { res = await fetch('/api/files/jobs', { cache: 'no-store' }); } catch { return null; }
  if (isSignedOutAnswer(res)) return 'signed-out';
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as JobsAnswer | null;
}

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => createJobsStore({
    load: loadJobs,
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (t) => window.clearTimeout(t as number),
    visible: () => document.visibilityState === 'visible',
    storage: () => { try { return window.localStorage; } catch { return null; } },
  }));
  useEffect(() => {
    store.start();
    const onVisibility = () => store.onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); store.stop(); };
  }, [store]);
  return <JobsContext.Provider value={store}>{children}</JobsContext.Provider>;
}

export function useJobsStore(): JobsStore {
  const s = useContext(JobsContext);
  if (!s) throw new Error('useJobsStore needs the app layout\'s JobsProvider');
  return s;
}

export function useJobsState(): JobsState {
  const s = useJobsStore();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}
