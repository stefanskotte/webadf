import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// The library while it loads (A1 States): the collections rail and the grid in the page's own row (library/page.tsx),
// so nothing jumps when the page lands -- the rail stacks above the grid below md, as the real one does. Cards in the
// grid's own columns (game-grid.tsx). Card-shaped even when the table view is coming -- a loading page sees no search
// params, so it cannot know which view was asked for.
export default function LibraryLoading() {
  return (
    <PageSkeleton testId="library-skeleton">
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {/* collection-rail.tsx's box: Uncategorized, a rule, a few collections, a rule, New collection. */}
        <div className="glass-card ml-4 mr-4 flex w-auto shrink-0 flex-col gap-2.5 p-3 sm:ml-7 sm:mr-7 md:mr-0 md:w-56"
             data-testid="library-skeleton-rail">
          <Bone className="h-4 w-2/3" />
          <div className="h-px" style={{ background: 'var(--hairline)' }} />
          {[3 / 4, 1 / 2, 2 / 3, 3 / 5].map((w, i) => <Bone key={i} className="h-3.5" style={{ width: `${w * 100}%` }} />)}
          <div className="h-px" style={{ background: 'var(--hairline)' }} />
          <Bone className="h-4 w-1/2" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mx-4 grid grid-cols-2 gap-4 sm:mx-7 sm:grid-cols-3 md:grid-cols-5">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="glass-card flex flex-col gap-2 p-2.5">
                <Bone style={{ aspectRatio: '1.23 / 1' }} className="w-full" />
                <Bone className="mt-1 h-3 w-3/4" />
                <Bone className="h-2.5 w-1/2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </PageSkeleton>
  );
}
