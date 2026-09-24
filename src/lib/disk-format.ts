// What kind of image a disk row holds. Named "image format", not "kind":
// src/lib/game-kind.ts already means Game/Demo/... by "kind", on the same pages.

import { ADF_BYTES } from '@/lib/adfmfm';

export type { ImageFormat } from '@/db/schema/catalog';

export function isHfeFilename(name: string): boolean {
  return /\.hfe$/i.test(name);
}

/**
 * Can the device image route turn this disk into WFMF? Decided by the row's
 * format, never by sniffing sizes (spec D2). An ADF must be exactly one DD
 * image because encodeDisk throws on anything else; an HFE was fully
 * validated at ingest (inspectHfe), and the route re-parses it per request.
 */
export function isServable(d: { imageFormat: string; sizeBytes: number }): boolean {
  if (d.imageFormat === 'adf') return d.sizeBytes === ADF_BYTES;
  if (d.imageFormat === 'hfe') return true;
  return false;
}
