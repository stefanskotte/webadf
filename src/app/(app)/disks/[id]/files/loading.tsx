import { Bone } from '@/components/shell/skeleton';

// The disk page while it loads (C4 spec 8.1): the crumb, the Disk card, then the files and the History side by side
// from xl. The real page has no page header (it starts at its breadcrumb), so this does not use PageSkeleton, whose
// header bones would push the card ~120 px down and make it jump on landing. Same status wrapper, same body frame and
// base column as page.tsx. Nested under (app)/loading.tsx like the library's, so status codes do not change.
export default function DiskFilesLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <div role="status" aria-busy="true" data-testid="disk-files-skeleton">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-5 px-4 pb-10 pt-6 sm:px-7">
        <Bone className="h-3 w-56" />
        {/* The Disk card's shape (disk-card.tsx): below lg it stacks -- a 56 px disk beside the 26 px heading, then the
            space bar -- so a phone does not jump ~90 px when the page lands (C7 spec §8, Ruling 27). */}
        <div data-skeleton-disk className="flex flex-col gap-4 rounded-[20px] p-4 sm:px-6 sm:py-5 lg:flex-row lg:items-center lg:gap-6" style={card}>
          <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-6">
            <Bone className="h-14 w-14 shrink-0 sm:h-[76px] sm:w-[76px]" />
            <div className="flex flex-1 flex-col gap-2"><Bone className="h-[27px] w-1/2 sm:h-[36px]" /><Bone className="h-3 w-2/3" /></div>
          </div>
          <Bone className="h-2 w-full lg:w-[300px]" />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-2 rounded-[20px] p-4" style={card}>
            <Bone className="h-9 w-full" />
            {Array.from({ length: 8 }, (_, i) => <div key={i} data-skeleton-row><Bone className="h-10 w-full" /></div>)}
          </div>
          <div className="flex flex-col gap-2 rounded-[20px] p-4" style={card}>
            <Bone className="h-5 w-24" />
            {Array.from({ length: 5 }, (_, i) => <div key={i} data-skeleton-version><Bone className="h-[52px] w-full" /></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
