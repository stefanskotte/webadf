import { Bone } from '@/components/shell/skeleton';

// Settings while it loads (C5 spec §2.7, Ruling 37): the page's own grid -- five nav bones from lg, then the heading
// and four cards in the main column. Not PageSkeleton: its outer header bones have no counterpart here (the heading is
// in the main column, `PageHeader flush`), and would make the page jump when it lands -- the C4 disk page's lesson.
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
          <div className="flex flex-col gap-1">
            <Bone className="h-5 w-24" />
            <Bone className="h-[30px] w-48 sm:h-[44px]" />
          </div>
          {[0, 1, 2, 3].map((c) => (
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
