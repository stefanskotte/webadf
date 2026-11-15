// How a title's disk rows read in Files (tester report 2026-11-15, operator ruling the same day). A row that said only
// "DSK Disk 1" read as a folder WebADF had made, and its files as going "into" it; they go on the disk image, at its
// root. So the row names what it is: "Disk 1 · ADF, 880 KB" -- the disk's label, the image's format and its size.
// Client-safe: no imports beyond the byte sizes.
import { ADF_BYTES, ADF_HD_BYTES } from '@/lib/adfmfm/constants';

/** Bytes as the panes show them: B under a KB, whole KB under a MB, then MB to one place. */
export function paneSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A disk image's size: an ADF by the names its two geometries go by everywhere else in the app (Create ADF, the disk
 * page), 880 KB and 1.76 MB -- paneSize would say "1.7 MB" for an HD disk; any other image (an HFE) as the panes count
 * bytes. Null when the size is not known.
 */
export function diskImageSize(format: 'adf' | 'hfe', sizeBytes: number | null): string | null {
  if (sizeBytes === null) return null;
  if (format === 'adf' && sizeBytes === ADF_BYTES) return '880 KB';
  if (format === 'adf' && sizeBytes === ADF_HD_BYTES) return '1.76 MB';
  return paneSize(sizeBytes);
}

export type DiskRowWords = {
  /** "ADF" or "HFE": what the library stores (an ADZ, DMS or DMZ was unpacked to an ADF when it was added). */
  format: string;
  /** "880 KB", "1.76 MB", or null when not known. */
  size: string | null;
  /** After the label: "ADF, 880 KB" ("ADF" alone with no size). */
  detail: string;
  /** What the row says in full: "Disk 1 · ADF, 880 KB". */
  text: string;
  /** What a screen reader hears: "disk image Disk 1, ADF, 880 KB". */
  spoken: string;
};

/** The words of a disk row (a DSK entry under a title): its label, then the image's format and size. */
export function diskRowWords(d: { name: string; imageFormat?: 'adf' | 'hfe'; size: number | null }): DiskRowWords {
  const fmt = d.imageFormat ?? 'adf';
  const format = fmt.toUpperCase();
  const size = diskImageSize(fmt, d.size);
  const detail = size ? `${format}, ${size}` : format;
  return { format, size, detail, text: `${d.name} · ${detail}`, spoken: `disk image ${d.name}, ${detail}` };
}
