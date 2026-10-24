import { Link } from '@/components/shell/link';

/**
 * The one card every "this page cannot be shown" state uses: failed, not found, not in your library. The board's look
 * (Phase C1, InfStates): surface, 20 px radius, a mono code line, a Bricolage heading, a sentence on what happened and
 * what did not, and the ways on.
 */
export function StateCard({ testId, code, codeTone = 'muted', title, message, children }: {
  testId: string;
  /** The small mono line above the heading: `404`, `Server error`. */
  code: string;
  /** `danger` for a failure (ErrorView), `muted` for a plain not-found. */
  codeTone?: 'muted' | 'danger';
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
        className="mx-auto flex max-w-[520px] flex-col gap-3 p-7"
        style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 20 }}
      >
        <span data-testid="state-code" className="font-mono text-[13px]"
              style={{ color: codeTone === 'danger' ? 'var(--danger-fg)' : 'var(--muted)' }}>{code}</span>
        <h1 className="text-[22px] font-bold leading-tight tracking-[-0.02em]"
            style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>
          {title}
        </h1>
        <p className="text-[14px] leading-relaxed" style={{ color: 'var(--muted)' }}>{message}</p>
        {children && <div className="mt-2 flex flex-wrap items-center gap-4">{children}</div>}
      </div>
    </div>
  );
}

/** The way on: a text link, or (`variant="button"`) the board's ink 40 px button. */
export function StateLink({ href, children, variant = 'link' }: {
  href: string;
  children: React.ReactNode;
  variant?: 'link' | 'button';
}) {
  if (variant === 'button') {
    return (
      <Link href={href}
            className="btn-like inline-flex h-10 items-center rounded-[10px] px-4 text-[14px] font-semibold text-white"
            style={{ background: 'var(--primary-action)' }}>
        {children}
      </Link>
    );
  }
  return (
    <Link href={href} className="text-[13.5px] font-semibold underline-offset-4 hover:underline"
          style={{ color: 'var(--primary-action)' }}>
      {children}
    </Link>
  );
}
