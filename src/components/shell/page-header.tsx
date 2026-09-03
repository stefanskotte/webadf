import { Breadcrumb, type Crumb } from '@/components/shell/breadcrumb';

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  /**
   * A plain label for a page that is not a drill-down ("Admin", "Hardware"),
   * or a clickable trail for one that is. One prop rather than two because
   * they occupy the same slot above the title and only ever one of them
   * applies -- and because this prop is the seam: change the contract here
   * and every page follows.
   */
  eyebrow?: string | Crumb[];
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    // Stacked below sm: the actions sit beside a title of unknown length, and
    // side by side at 390px there is nothing left for either. justify-between
    // is deliberately sm-only -- along the column axis it would push the
    // actions to the bottom of whatever height the row happened to have,
    // rather than keeping them under the title. px-4 there per spec D-6-9:
    // px-7 is 14% of a 390px screen.
    <div className="flex flex-col items-start gap-3 px-4 pb-5 pt-6 sm:flex-row sm:items-end sm:justify-between sm:gap-0 sm:px-7">
      <div className="flex flex-col gap-1">
        {Array.isArray(eyebrow) ? (
          <Breadcrumb crumbs={eyebrow} />
        ) : eyebrow ? (
          <span
            className="text-[12.5px] font-semibold"
            style={{ color: "var(--on-dark-muted)" }}
          >
            {eyebrow}
          </span>
        ) : null}
        <h1
          // 26px below sm: at 34px a two-word title ("Disk contents") wraps
          // on a 390px screen, and leading-none makes a wrapped heading read
          // as one solid block.
          className="text-[26px] font-bold leading-none tracking-[-0.032em] sm:text-[34px]"
          style={{ color: "var(--on-dark)" }}
        >
          {title}
        </h1>
        {subtitle && (
          <span
            className="mt-1 font-mono text-[11.5px]"
            style={{ color: "var(--on-dark-muted)" }}
          >
            {subtitle}
          </span>
        )}
      </div>
      {actions}
    </div>
  );
}
