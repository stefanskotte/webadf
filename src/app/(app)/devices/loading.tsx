import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// The devices page while it loads (spec 9.2): a heading and subtitle bone, then one card-shaped bone holding the
// drive tile, the name, the four facts and the drive box; from lg a dashed aside bone beside it, as the real page
// lays out a single board. Nested under (app)/loading.tsx like the library's, so status codes do not change.
export default function DevicesLoading() {
  return (
    <PageSkeleton testId="devices-skeleton">
      <div className="flex flex-col gap-2 px-4 pb-4 sm:px-7">
        <Bone className="h-11 w-48" />
        <Bone className="h-3 w-64" />
      </div>
      <div className="grid grid-cols-1 items-stretch gap-6 px-4 pb-10 sm:px-7 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4 rounded-[20px] p-4" style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          <div className="flex flex-col gap-4 md:flex-row">
            <Bone className="h-[176px] w-full md:w-[340px] md:shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-3.5">
              <Bone className="h-7 w-2/3" />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {Array.from({ length: 4 }, (_, i) => <div key={i} data-skeleton-cell><Bone className="h-10" /></div>)}
              </div>
            </div>
          </div>
          <Bone className="h-[96px] w-full" />
        </div>
        <div data-testid="devices-skeleton-aside" className="hidden rounded-[20px] lg:block"
             style={{ border: '1.5px dashed var(--line-strong)' }} />
      </div>
    </PageSkeleton>
  );
}
