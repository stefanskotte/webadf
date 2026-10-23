/**
 * Loading placeholders (A1 States): grey shapes where the page's header and content will be, shown by a loading.tsx
 * while the server renders the page -- the app's only navigation feedback (the top progress bar was removed
 * 2026-10-23, operator: the placeholders say it). No ids that
 * a real page uses, so a test waiting for real content never mistakes a placeholder for it.
 */

/** One grey shape. `onDark` for shapes over the gradient's dark top band (the page header). */
export function Bone({ className = '', onDark = false, style }: { className?: string; onDark?: boolean; style?: React.CSSProperties }) {
  return (
    <div
      aria-hidden
      className={`rounded-md motion-safe:animate-pulse ${className}`}
      style={{ background: onDark ? 'rgb(255 255 255 / 0.16)' : 'rgb(30 45 60 / 0.08)', ...style }}
    />
  );
}

/** The page header's shape: eyebrow, title, subtitle -- laid out as PageHeader lays them out. */
export function HeaderSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-4 pb-5 pt-6 sm:px-7">
      <Bone onDark className="h-3 w-24" />
      <Bone onDark className="h-[26px] w-56 sm:h-[34px]" />
      <Bone onDark className="mt-1 h-3 w-40" />
    </div>
  );
}

/** A whole loading page: what screen readers hear, and the header; the body is the caller's. */
export function PageSkeleton({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" data-testid={testId}>
      <span className="sr-only">Loading…</span>
      <HeaderSkeleton />
      {children}
    </div>
  );
}
