/**
 * The per-disk name a board's OLED prints after its own "n/c" counter (or
 * alone, on a one-disk title), and the AmigaDOS volume name it is usually
 * taken from.
 *
 * Field report 2026-10-17: a 13-disk Workbench 3.2 set showed "Disk 1/13
 * Disk 1" -- nothing ever wrote disks.label for an upload or a set, so the
 * server sent its "Disk n" fallback, which the firmware printed right after
 * the counter it already drew. The same day the operator dropped the word
 * "Disk" from the board altogether ("it's already implied"): firmware 1.14.0
 * prints "3/13 Locale" (nfc_ui_disk_line in wifi-floppy/firmware/src/nfc_ui.c);
 * older firmware still prints "Disk 3/13 Locale".
 *
 * The rule, first non-empty of:
 *   1. disks.label -- a person's, extract's ("Extracted from ..."), or the
 *      volume name stored when the disk was uploaded or put in a set (the
 *      volume name is persisted rather than read from the bytes per mount);
 *   2. the uploaded file name without its image extension (the org's own
 *      entitlements.source_filename for those bytes);
 *   3. nothing -- on a set the counter says which disk it is, and a one-disk
 *      title has its game title on the line above; "Disk n" is never sent.
 *
 * Pure apart from volumeNameOf's parse, so mount.ts (the poll body) and
 * live-display.ts (the web's copy of the screen) share exactly one rule.
 */
import { readVolume } from '@/lib/adffs';
import { DC_LABEL_MAX } from '@/lib/device-limits';

/** Only a disk image's own extension: "Game v1.2" (no extension) keeps its ".2". */
export const stripImageExt = (name: string) => name.replace(/\.(adf|adz|dms|dmz|hfe|ipf)$/i, '').trim();

export interface DiskLabelInput {
  label: string | null;
  sourceFilename: string | null;
}

export function boardDiskLabel(d: DiskLabelInput): string {
  const own = d.label?.trim() ?? '';
  const file = d.sourceFilename ? stripImageExt(d.sourceFilename) : '';
  return (own || file).slice(0, DC_LABEL_MAX);
}

/**
 * The AmigaDOS volume name, or null for a blank one and for anything that is
 * not a DOS disk (a game disk, an HFE, the wrong size). Never throws.
 */
export function volumeNameOf(bytes: Uint8Array): string | null {
  try {
    const v = readVolume(bytes);
    if (!v.ok) return null;
    const name = v.volume.name.trim();
    return name === '' ? null : name;
  } catch {
    return null;
  }
}
