// The admin Scan page's rules (C6 spec §5.6): pure and client-safe. The coverage arithmetic is the page's, moved
// verbatim (A7 and the TOSEC scan design), so the card's "% recognised" uses the same corrected `decided`.
import type { ScanStatus } from '@/lib/tosec-sweep';

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface Coverage {
  decided: number; matched: number; genuineNone: number; authoredDecided: number;
  /** matched / decided, rounded; null with nothing decided. */
  recognisedPct: number | null;
  /** The bar's two fills, in percent of the track. */
  okW: number; missW: number;
}

function withWidths(c: Pick<Coverage, 'decided' | 'matched' | 'genuineNone' | 'authoredDecided'>): Coverage {
  if (c.decided <= 0) return { ...c, recognisedPct: null, okW: 0, missW: 0 };
  return {
    ...c,
    recognisedPct: Math.round((c.matched / c.decided) * 100),
    okW: (c.matched / c.decided) * 100,
    missW: (c.genuineNone / c.decided) * 100,
  };
}

export function scanCoverage(s: Pick<ScanStatus, 'matched' | 'none' | 'ambiguous' | 'unreadable' | 'authoredNone'>): Coverage {
  // A blob whose bytes could not be read is stamped hashed (so the sweeper does not spin on it forever) with null
  // hashes, and phase 2's short circuit then always files it under match_state = 'none' -- so `none` conflates
  // "TOSEC does not know this disk" with "the object store failed us". Every checked-unreadable blob is counted in
  // both `none` and `unreadable`; subtracting min(unreadable, none) removes exactly that overlap (capped so a
  // still-unchecked unreadable blob, not yet folded into `none`, cannot drive the count negative).
  const unreadableDecided = Math.min(s.unreadable, s.none);
  // ...and the same treatment for disks somebody MADE here: a disk the operator authored is in no preservation set
  // and never will be, so counting it would report their own work as a gap in the archive. Capped against what is
  // left after the unreadable subtraction so the two corrections cannot overlap into a negative count.
  const authoredDecided = Math.min(s.authoredNone, Math.max(0, s.none - unreadableDecided));
  const excluded = unreadableDecided + authoredDecided;
  const genuineNone = s.none - excluded;
  const decided = s.matched + s.none + s.ambiguous - excluded;
  return withWidths({ decided, matched: s.matched, genuineNone, authoredDecided });
}

export function enrichCoverage(s: Pick<ScanStatus, 'enriched' | 'enrichNone' | 'enrichAmbiguous'>): Coverage {
  return withWidths({
    decided: s.enriched + s.enrichNone + s.enrichAmbiguous, matched: s.enriched, genuineNone: s.enrichNone,
    authoredDecided: 0,
  });
}

export type ScanNoteKind = 'unchecked' | 'unreadable' | 'no-openretro' | 'enrich' | 'done';

/** Every status line that applies, in this order; `done` alone when none does (Ruling 24). */
export function scanNotes(
  s: Pick<ScanStatus, 'unchecked' | 'unreadable' | 'openretroEntries' | 'enrichUnchecked'>,
): { kind: ScanNoteKind; text: string }[] {
  const out: { kind: ScanNoteKind; text: string }[] = [];
  if (s.unchecked > 0) {
    out.push({ kind: 'unchecked', text: `${s.unchecked} ${plural(s.unchecked, 'blob', 'blobs')} still to process. Each run is bounded and resumable — run it again, or leave it to the nightly run.` });
  }
  if (s.unreadable > 0) {
    const one = s.unreadable === 1;
    out.push({ kind: 'unreadable', text: `${s.unreadable} ${one ? 'blob' : 'blobs'} could not be read from storage and ${one ? 'was' : 'were'} stamped hashed with no hash — ${one ? 'it always reports' : 'they always report'} as no match, not a genuine TOSEC miss.` });
  }
  if (s.openretroEntries === 0) {
    out.push({ kind: 'no-openretro', text: 'No OpenRetro metadata loaded. Nothing can be enriched until an Amiga.sqlite is uploaded below.' });
  } else if (s.enrichUnchecked > 0) {
    out.push({ kind: 'enrich', text: `${s.enrichUnchecked} ${plural(s.enrichUnchecked, 'blob', 'blobs')} still to enrich. Image fetching is capped per run on purpose, so a first pass over a large library takes several runs — or several nights.` });
  }
  if (out.length === 0) out.push({ kind: 'done', text: 'Every blob is processed; the nightly run picks up new uploads.' });
  return out;
}
