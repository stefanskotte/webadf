import type { ReleaseRef } from '@/lib/firmware-state';

/**
 * Shown only when at least one device is behind.
 *
 * Styled with the amber treatment the stale-device state already uses rather
 * than a colour invented for this, so the page keeps one vocabulary for
 * "something here wants attention".
 *
 * It states a fact and offers no action, because there is no action yet: no
 * firmware is served or flashed by this increment (spec §4). A button that
 * cannot work would be worse than none.
 */
export function FirmwareNotice({
  behind,
  total,
  latest,
  security,
}: {
  behind: number;
  total: number;
  latest: ReleaseRef;
  /** True when any release newer than some behind device's is a security one. */
  security: boolean;
}) {
  if (behind === 0) return null;

  return (
    <div
      className="glass-card flex flex-col gap-1 p-4"
      data-testid="firmware-notice"
      style={{ borderColor: 'var(--amber-text)' }}
    >
      <span
        className="text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: 'var(--amber-text)' }}
      >
        {security ? 'Security update available' : 'Firmware update available'}
      </span>
      <span className="text-[13px]" style={{ color: 'var(--ink)' }}>
        {behind} of {total} {total === 1 ? 'device is' : 'devices are'} behind{' '}
        {/*
          The FULL version, not the semver. Two releases may share a semver --
          decidePublish allows a rebuild that did not warrant a bump -- and
          naming the semver then told a user they were behind the exact
          version their own card said they were running. The suffix is what
          makes a version an identity; dropping it here reintroduced, in the
          one place a human reads for what to do, the confusion this whole
          increment exists to remove.
        */}
        <strong className="break-all font-mono">{latest.version}</strong>.
      </span>
      {latest.notes && (
        <span className="text-[13px]" style={{ color: 'var(--muted)' }}>
          {latest.notes}
        </span>
      )}
    </div>
  );
}
