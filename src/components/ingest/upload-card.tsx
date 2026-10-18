/**
 * One of the Upload page's two cards. The header row has a fixed minimum height so the two cards' drop zones
 * start on the same line whatever sits at its right (the Send side's board and Receive chip).
 */
export function UploadCard({
  id, title, help, meta, children, testId,
}: {
  id: string;
  title: string;
  help?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section aria-labelledby={id} className="glass-card flex min-w-0 flex-col" data-testid={testId}>
      <header className="flex min-h-[54px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5"
              style={{ borderBottom: '1px solid var(--hairline)' }}>
        <h2 id={id} className="flex items-center gap-1 text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
          {title}{help}
        </h2>
        {meta && <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">{meta}</div>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

/** The framed list at the bottom of each card: a header row (title, counts, an action) over its rows. */
export function ListFrame({
  title, counts, action, children,
}: {
  title: string;
  counts?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl"
         style={{ border: '1px solid var(--hairline-strong)', background: 'var(--glass-subtle)' }}>
      <div className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2" style={{ borderBottom: '1px solid var(--hairline)' }}>
        <span className="text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</span>
        {counts && <span className="text-[12px]" style={{ color: 'var(--muted)' }}>{counts}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </div>
  );
}
