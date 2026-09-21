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
}: {
  behind: number;
  total: number;
  latest: ReleaseRef;
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
        {latest.security ? 'Security update available' : 'Firmware update available'}
      </span>
      <span className="text-[13px]" style={{ color: 'var(--ink)' }}>
        {behind} of {total} {total === 1 ? 'device is' : 'devices are'} behind{' '}
        <strong>{latest.semver}</strong>.
      </span>
    </div>
  );
}
