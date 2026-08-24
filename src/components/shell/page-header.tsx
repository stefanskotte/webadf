export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between px-7 pb-5 pt-6">
      <div className="flex flex-col gap-1">
        {eyebrow && (
          <span
            className="text-[12.5px] font-semibold"
            style={{ color: "var(--on-dark-muted)" }}
          >
            {eyebrow}
          </span>
        )}
        <h1
          className="text-[34px] font-bold leading-none tracking-[-0.032em]"
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
