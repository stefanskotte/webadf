import { Bone } from '@/components/shell/skeleton';

// A title page while it loads (Phase C1 States): a breadcrumb bone, a hero-shaped card and two disk rows, in the
// shapes title-hero.tsx and disk-row.tsx draw, so nothing jumps when the page lands. Nested under (app)/loading.tsx,
// which already streams this route, so status codes do not change (not-found stays HTTP 200 with its card).
export default function GameLoading() {
  return (
    <div role="status" aria-busy="true" data-testid="title-skeleton" className="flex flex-col gap-5 px-4 pb-8 pt-6 sm:px-7">
      <span className="sr-only">Loading…</span>
      <Bone className="h-3.5 w-44" />
      <div className="glass-card flex flex-col gap-6 rounded-[20px] p-5 sm:p-7 lg:flex-row lg:items-center lg:gap-9">
        <Bone className="h-[240px] w-[260px] max-w-full shrink-0 self-center lg:self-auto" />
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          <Bone className="h-12 w-3/4" />
          <div data-skeleton-pills className="flex flex-wrap gap-2">
            {[72, 64, 56, 96].map((w, i) => <Bone key={i} className="h-7 rounded-full" style={{ width: w }} />)}
          </div>
          <Bone className="h-[88px] w-[360px] max-w-full" />
        </div>
      </div>
      {[0, 1].map((i) => (
        <div key={i} data-skeleton-disk-row className="glass-card flex items-center gap-4 p-4">
          <Bone className="h-10 w-10 shrink-0" />
          <div className="flex flex-1 flex-col gap-2">
            <Bone className="h-3.5 w-1/3" />
            <Bone className="h-3 w-1/4" />
          </div>
          <Bone className="h-8 w-24" />
        </div>
      ))}
    </div>
  );
}
