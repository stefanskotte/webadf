import type { DeviceListItem } from '@/lib/queries';
import { sel1Text, df1SeenText } from '@/lib/second-drive';

/** The board's two SEL1 readings, as words. Nothing for firmware too old to make them. */
export function SecondDriveReadings({ device }: { device: DeviceListItem }) {
  if (device.sel1Wired === null || device.df1Seen === null) return null;
  return (
    <span className="flex flex-col text-[11px]" style={{ color: 'var(--muted)' }}>
      <span data-testid={`device-sel1-${device.id}`} data-value={String(device.sel1Wired)}>
        {sel1Text(device.sel1Wired)}
      </span>
      <span data-testid={`device-df1seen-${device.id}`} data-value={String(device.df1Seen)}>
        {df1SeenText(device.df1Seen)}
      </span>
    </span>
  );
}
