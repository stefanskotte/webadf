import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// Any admin page while it loads: a header and one card of lines, as the app's own loading.tsx draws. The admin's
// only navigation feedback since the top progress bar went (2026-10-23).
export default function AdminLoading() {
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
