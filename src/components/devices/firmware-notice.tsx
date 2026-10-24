import { Upload } from 'lucide-react';
import type { ReleaseRef } from '@/lib/firmware-state';

/**
 * Shown only when at least one device is behind (spec §1.3; board: `section[aria-label="Firmware update"]`).
 *
 * It states a fact. With exactly one board that can be updated it also offers the action (`oneName` + `onUpdateOne`,
 * Ruling 13); with several, the per-card ticks and the update bar do it. The caller (DeviceList) decides.
 */
export function FirmwareNotice({
  behind,
  total,
  latest,
  security,
  oneName,
  onUpdateOne,
}: {
  behind: number;
  total: number;
  latest: ReleaseRef;
  /** True when any release newer than some behind device's is a security one. */
  security: boolean;
  /** The one selectable board's name; with `onUpdateOne` it draws `Update <name>`. */
  oneName?: string;
  onUpdateOne?: () => void;
}) {
  if (behind === 0) return null;

  return (
    <section
      aria-label="Firmware update"
      className="flex flex-wrap items-center gap-4 rounded-2xl px-[18px] py-4"
      data-testid="firmware-notice"
      style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--fw-line)' }}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl"
            style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}>
        <Upload size={20} strokeWidth={2} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
          {/*
            The FULL version, not the semver. Two releases may share a semver -- decidePublish allows a rebuild that
            did not warrant a bump -- and naming the semver then told a user they were behind the exact version
            their own card said they were running. The suffix is what makes a version an identity.
          */}
          {security ? 'Security update ' : 'Firmware '}
          <span className="break-all font-mono">{latest.version}</span> is available
          <span className="font-normal" style={{ color: 'var(--muted)' }}>
            {` · ${behind} of ${total} ${total === 1 ? 'device is' : 'devices are'} behind`}
          </span>
        </span>
        {latest.notes && (
          <span className="text-[13px]" style={{ color: 'var(--muted)' }}>
            {latest.notes}
          </span>
        )}
      </div>
      {oneName !== undefined && onUpdateOne && (
        <button type="button" onClick={onUpdateOne} data-testid="firmware-notice-update"
                className="h-[38px] max-w-full shrink-0 truncate rounded-[10px] px-4 text-[14px] font-semibold"
                style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
          Update {oneName}
        </button>
      )}
    </section>
  );
}
