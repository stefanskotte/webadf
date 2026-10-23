import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// Any app page while it loads (A1 States): a header and one card of lines. The library has its own (card grid).
export default function AppLoading() {
  return (
    <PageSkeleton testId="page-skeleton">
      <div className="glass-card mx-4 flex flex-col gap-3 p-5 sm:mx-7">
        <Bone className="h-4 w-1/3" />
        <Bone className="h-3 w-full" />
        <Bone className="h-3 w-5/6" />
        <Bone className="h-3 w-2/3" />
      </div>
    </PageSkeleton>
  );
}
