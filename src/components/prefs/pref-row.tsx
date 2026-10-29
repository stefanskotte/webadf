import { SETTINGS_ROW } from '@/lib/settings-look';

/** One Preferences row (spec §2.2): the label and hint on the left, the control on the right; stacked below sm. */
export function PrefRow({ labelId, hintId, label, hint, children }: {
  labelId: string; hintId: string; label: string; hint: string; children: React.ReactNode;
}) {
  return (
    <div className={`${SETTINGS_ROW} border-t py-3.5`} style={{ borderColor: 'var(--hairline)' }}>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span id={labelId} className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{label}</span>
        <span id={hintId} className="text-[13px]" style={{ color: 'var(--muted-2)' }}>{hint}</span>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
