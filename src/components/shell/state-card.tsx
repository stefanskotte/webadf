import { Link } from '@/components/shell/link';

/**
 * The one card every "this page cannot be shown" state uses: failed, not found, not in your library. A heading, a
 * sentence on what happened and what did not, and the ways on. In today's look (redesign Phase A); Phase B restyles
 * it once, here.
 */
export function StateCard({ testId, title, message, children }: {
  testId: string;
  title: string;
  message: string;
  /** The actions: a button, a link, a reference line. */
  children?: React.ReactNode;
}) {
  return (
    <div className="px-4 pt-6 sm:px-7">
      <div
        role="alert"
        data-testid={testId}
        className="glass-card mx-auto flex max-w-[520px] flex-col gap-3 px-6 py-7"
      >
        <h1 className="text-[22px] font-bold leading-tight tracking-[-0.02em]" style={{ color: 'var(--ink)' }}>
          {title}
        </h1>
        <p className="text-[14px] leading-relaxed" style={{ color: 'var(--muted)' }}>{message}</p>
        {children && <div className="mt-2 flex flex-wrap items-center gap-4">{children}</div>}
      </div>
    </div>
  );
}

/** The quiet way on: a text link, beside or instead of the main action. */
export function StateLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-[13.5px] font-semibold underline-offset-4 hover:underline"
          style={{ color: 'var(--primary-action)' }}>
      {children}
    </Link>
  );
}
