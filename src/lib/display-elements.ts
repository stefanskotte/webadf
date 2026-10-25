import type { ElementName } from '@/lib/display-layout';

/** The display editor's element list (Devices spec §10.3): each element's name and the hint under it. */
export const ELEMENT_LOOK: Record<ElementName, { label: string; hint: string }> = {
  status: { label: 'Status', hint: 'READY, LOADING, LOADED — or an icon' },
  wifi: { label: 'Wi-Fi', hint: 'Signal bars, top left' },
  write: { label: 'Write-protect', hint: 'Lock when the disk is read-only' },
  title: { label: 'Title', hint: 'Name of the disk in the drive' },
  detail: { label: 'Detail', hint: 'Disk n of n' },
  track: { label: 'Track', hint: 'Head position, e.g. 42↑79' },
  download: { label: 'Download', hint: 'Progress bar while loading' },
  lemming: { label: 'Lemming', hint: 'Activity sprite, top right' },
  nfc: { label: 'NFC', hint: 'Reader icon, struck when none is found' },
};
