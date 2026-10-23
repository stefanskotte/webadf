import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// The library while it loads (A1 States): cards in the grid's own columns (game-grid.tsx). Card-shaped even when the
// table view is coming -- a loading page sees no search params, so it cannot know which view was asked for.
export default function LibraryLoading() {
  return (
    <PageSkeleton testId="library-skeleton">
      <div className="mx-4 grid grid-cols-2 gap-4 sm:mx-7 sm:grid-cols-3 md:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="glass-card flex flex-col gap-2 p-2.5">
            <Bone style={{ aspectRatio: '1.23 / 1' }} className="w-full" />
            <Bone className="mt-1 h-3 w-3/4" />
            <Bone className="h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    </PageSkeleton>
  );
}
