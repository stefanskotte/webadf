import { Bone } from '@/components/shell/skeleton';

// Any admin page while it loads (C6 spec §1.7, Ruling 37): the admin frame -- the lg head in PageHeader's gutter,
// the tabs, one card of rows. Not PageSkeleton: its md header bones would jump when the 44 px heading lands.
// page-skeleton and the status wrapper are kept.
export default function AdminLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <div role="status" aria-busy="true" data-testid="page-skeleton">
      <span className="sr-only">Loading…</span>
      {/* The heights are PageHeader's lg head: two 19.5 px text lines (13 px at line-height 1.5), the heading,
          gap-1 between them and mt-1 above the subtitle, so the tabs do not move when the page lands. */}
      <div className="flex flex-col gap-1 px-4 pb-5 pt-6 sm:px-7">
        <Bone className="h-[19.5px] w-40" />
        <Bone className="h-[30px] w-56 sm:h-[44px]" />
        <Bone className="mt-1 h-[19.5px] w-72 max-w-full" />
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
