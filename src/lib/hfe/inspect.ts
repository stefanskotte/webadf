// Everything ingest needs to know about an uploaded HFE, in one call that
// never throws (it runs in the browser drop path and in /api/ingest/complete).

import { parseHfe } from './parse';
import { hasAmigaBootTrack, extractAdf } from './extract';
import { tooLongTrack, longestServedTrackBits } from './to-wfmf';
import { NOT_AMIGA, WEAK_BIT_NOTICE, extraCylindersNotice } from './messages';

export type HfeInspection =
  | {
      ok: true; cylinders: number; notices: string[]; extractable: boolean; extractReason: string | null;
      /** The longest served side, in bits: what a board's firmware must hold to play it. */
      maxTrackBits: number;
    }
  | { ok: false; reason: string };

export function inspectHfe(bytes: Uint8Array): HfeInspection {
  try {
    const p = parseHfe(bytes);
    if (!p.ok) return p;
    const long = tooLongTrack(p.disk);
    if (long) return { ok: false, reason: long };
    if (!hasAmigaBootTrack(p.disk)) return { ok: false, reason: NOT_AMIGA };
    const x = extractAdf(p.disk);
    const notices = [WEAK_BIT_NOTICE];
    if (p.disk.cylinders > 80) notices.push(extraCylindersNotice(p.disk.cylinders));
    return {
      ok: true, cylinders: p.disk.cylinders, notices,
      extractable: x.ok, extractReason: x.ok ? null : x.reason,
      maxTrackBits: longestServedTrackBits(p.disk),
    };
  } catch {
    return { ok: false, reason: 'This HFE file could not be read.' };
  }
}

/** One line for an upload row. */
export function describeInspection(r: Extract<HfeInspection, { ok: true }>): string {
  const tail = r.extractable ? 'extractable as ADF' : `play only — ${r.extractReason}`;
  return [...r.notices, tail].join(' · ');
}
