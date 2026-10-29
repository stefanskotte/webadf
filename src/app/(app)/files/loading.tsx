import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// Files while it loads (Files spec §5.1): the page header's bones, then the manager's own card -- left pane, the
// 92 px button column, right pane -- in the grid files-manager.tsx draws, so nothing jumps when the page lands.
// Below lg the manager stacks, and so do these.
function PaneBone() {
  return (
    <div data-skeleton-pane className="flex min-w-0 flex-col gap-2 p-3.5 max-lg:h-[460px]">
      <div className="flex gap-1.5"><Bone className="h-6 w-20" /></div>
      <Bone className="h-4 w-1/2" />
      <div className="mt-2 flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, i) => <Bone key={i} className="h-6 w-full" />)}
      </div>
    </div>
  );
}

export default function FilesLoading() {
  return (
    <PageSkeleton testId="files-skeleton">
      <div className="px-4 pb-10 sm:px-7">
        <div className="grid overflow-hidden rounded-[20px] lg:h-[clamp(480px,calc(100dvh-260px),900px)] lg:grid-cols-[minmax(0,1fr)_92px_minmax(0,1fr)]"
             style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          <PaneBone />
          <div data-skeleton-actions className="flex flex-wrap gap-[7px] px-2 py-4 lg:flex-col"
               style={{ background: 'var(--surface-2)' }}>
            {Array.from({ length: 10 }, (_, i) => <Bone key={i} className="h-7 w-[72px] lg:w-full" />)}
          </div>
          <PaneBone />
        </div>
      </div>
    </PageSkeleton>
  );
}
