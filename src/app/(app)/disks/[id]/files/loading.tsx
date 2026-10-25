import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// The disk page while it loads (C4 spec 8.1): the crumb, the Disk card, then the files and the History side by side
// from xl. Nested under (app)/loading.tsx like the library's, the devices' and the upload page's, so status codes do
// not change.
export default function DiskFilesLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <PageSkeleton testId="disk-files-skeleton">
      <div className="flex flex-col gap-5 px-4 pb-10 pt-6 sm:px-7">
        <Bone className="h-3 w-56" />
        <div data-skeleton-disk className="flex flex-col gap-4 rounded-[20px] p-5 lg:flex-row lg:items-center" style={card}>
          <Bone className="h-[76px] w-[76px] shrink-0" />
          <div className="flex flex-1 flex-col gap-2"><Bone className="h-[34px] w-1/2" /><Bone className="h-3 w-2/3" /></div>
          <Bone className="h-2 w-full lg:w-[300px]" />
        </div>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex flex-col gap-2 rounded-[20px] p-4" style={card}>
            <Bone className="h-9 w-full" />
            {Array.from({ length: 8 }, (_, i) => <div key={i} data-skeleton-row><Bone className="h-10 w-full" /></div>)}
          </div>
          <div className="flex flex-col gap-2 rounded-[20px] p-4" style={card}>
            <Bone className="h-5 w-24" />
            {Array.from({ length: 5 }, (_, i) => <div key={i} data-skeleton-version><Bone className="h-[52px] w-full" /></div>)}
          </div>
        </div>
      </div>
    </PageSkeleton>
  );
}
