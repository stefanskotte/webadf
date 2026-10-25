import { Bone } from '@/components/shell/skeleton';

// Any admin page while it loads (C6 spec §1.7, Ruling 37): the admin frame -- the lg head in PageHeader's gutter,
// the tabs, one card of rows. Not PageSkeleton: its md header bones would jump when the 44 px heading lands.
// page-skeleton and the status wrapper are kept.
export default function AdminLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <div role="status" aria-busy="true" data-testid="page-skeleton">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2 px-4 pb-5 pt-6 sm:px-7">
        <Bone className="h-[13px] w-40" />
        <Bone className="h-[30px] w-56 sm:h-[44px]" />
        <Bone className="h-[13px] w-72 max-w-full" />
      </div>
      <div className="px-4 pb-6 sm:px-7">
        <Bone className="h-[42px] w-[420px] max-w-full" style={{ borderRadius: 12 }} />
      </div>
      <div className="px-4 pb-10 sm:px-7">
        <div className="flex flex-col gap-3 rounded-[16px] p-5" style={card}>
          {Array.from({ length: 6 }, (_, i) => <div key={i} data-skeleton-row><Bone className="h-11 w-full" /></div>)}
        </div>
      </div>
    </div>
  );
}
