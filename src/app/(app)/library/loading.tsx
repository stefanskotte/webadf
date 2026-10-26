import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// The library while it loads (A1 States): the collections rail and the grid in the page's own row (library/page.tsx),
// so nothing jumps when the page lands -- below md the collections are a chip row above the grid, as the real page has. Cards in the
// grid's own columns (game-grid.tsx). Card-shaped even when the table view is coming -- a loading page sees no search
// params, so it cannot know which view was asked for.
export default function LibraryLoading() {
  return (
    <PageSkeleton testId="library-skeleton">
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {/* Below md the collections are one 44 px chip row (collection-rail.tsx, C7 spec §4.2). */}
        <div className="flex gap-2 overflow-hidden px-4 sm:px-7 md:hidden" data-testid="library-skeleton-chips">
          {[28, 24, 24, 20].map((w, i) => <Bone key={i} className="h-11 shrink-0 rounded-full" style={{ width: `${w * 4}px` }} />)}
        </div>
        {/* From md, collection-rail.tsx's box: a caption and six 38 px rows, no card. */}
        <div className="ml-7 hidden w-60 shrink-0 flex-col gap-1 px-1 md:flex md:w-60"
             data-testid="library-skeleton-rail">
          <Bone className="mb-1.5 h-3 w-24" />
          {Array.from({ length: 6 }, (_, i) => <Bone key={i} className="h-[38px] w-full" />)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mx-4 grid grid-cols-2 gap-4 sm:mx-7 sm:grid-cols-3 md:grid-cols-5 md:gap-5">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="glass-card flex flex-col gap-2 p-2.5">
                <Bone style={{ aspectRatio: '4 / 5' }} className="w-full" />
                <Bone className="mt-1 h-3 w-3/4" />
                <Bone className="h-2.5 w-1/2" />
                <div data-card-footer-bone className="mt-0.5"><Bone className="h-2.5 w-1/3" /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PageSkeleton>
  );
}
