import { Bone } from '@/components/shell/skeleton';

// Settings › Account while it loads (C5 spec §2.7, Ruling 37; tabs 2026-10-28): the tab's own grid -- five nav bones
// from lg, then its five cards. The heading and the tabs are the layout's and stay drawn, so there are no heading bones.
// Same status wrapper. Nested under (app)/loading.tsx like the other areas', so status codes do not change.
export default function SettingsLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <div role="status" aria-busy="true" data-testid="settings-skeleton">
      <span className="sr-only">Loading…</span>
      <div className="px-4 pb-10 pt-6 sm:px-7 lg:grid lg:grid-cols-[240px_minmax(0,860px)] lg:items-start lg:gap-8">
        <div className="hidden flex-col gap-0.5 lg:flex">
          {Array.from({ length: 5 }, (_, i) => <div key={i} data-skeleton-nav><Bone className="h-[38px] w-full" /></div>)}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {[0, 1, 2, 3, 4].map((c) => (
            <div key={c} data-skeleton-card className="flex flex-col gap-3 rounded-[20px] p-5 sm:p-6" style={card}>
              {c === 0 ? (
                <>
                  <Bone className="h-[17px] w-32" />
                  {Array.from({ length: 4 }, (_, i) => <div key={i} data-skeleton-row><Bone className="h-12 w-full" /></div>)}
                </>
              ) : (
                <>
                  <Bone className="h-3 w-1/3" />
                  <Bone className="h-3 w-2/3" />
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
