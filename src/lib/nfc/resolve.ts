/**
 * Resolves an operator's free-text `nfc:write` query against the org's disks
 * (spec §5.5). Pure -- no I/O -- so it is fully unit-tested; the script does
 * nothing but load `rows` and print the result.
 */
import { DISK_ID_RE } from './rules';

export type DiskCandidate = {
  id: string;
  title: string;
  diskNo: number;
  tosecName: string | null;
  sourceFilename: string | null;
};

export type ResolveResult =
  | { kind: 'one'; disk: DiskCandidate }
  | { kind: 'many'; disks: DiskCandidate[] }
  | { kind: 'none' };

const eqCI = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
const containsCI = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase());

const TRAILING_DISK_NO_RE = /\s+disk\s+(\d+)$/i;

/**
 * Rules, in order (spec §5.5 / task 6 brief):
 *  1. A literal `stableId` resolves directly to that row, or `none` -- no
 *     other rule is consulted, so an id-shaped string never falls through to
 *     a title guess.
 *  2. An exact, case-insensitive match on `tosecName` or `sourceFilename`
 *     is a candidate.
 *  3. A trailing "disk N" is stripped from the query and remembered.
 *  4. Any row whose title EQUALS what's left (case-insensitive), filtered to
 *     that disk number when one was given, is a candidate. Only when no title
 *     is an exact match does containment count instead -- so "Turrican disk 1"
 *     is Turrican, not Turrican II too.
 *  5. The candidates from 2 and 4 are combined (deduplicated by id): one ->
 *     `one`, several -> `many`, none -> `none`. Combining rather than
 *     short-circuiting on step 2 is what makes an exact filename match on one
 *     disk and a title match on another come back `many` instead of a guess.
 */
export function resolveDiskQuery(rows: DiskCandidate[], query: string): ResolveResult {
  if (DISK_ID_RE.test(query)) {
    const row = rows.find((r) => r.id === query);
    return row ? { kind: 'one', disk: row } : { kind: 'none' };
  }

  const exactMatches = rows.filter((r) => eqCI(r.tosecName, query) || eqCI(r.sourceFilename, query));

  const m = TRAILING_DISK_NO_RE.exec(query);
  const rest = m ? query.slice(0, m.index) : query;
  const diskNo = m ? Number(m[1]) : null;
  const diskOk = (r: DiskCandidate) => diskNo === null || r.diskNo === diskNo;
  const exactTitle = rows.filter((r) => eqCI(r.title, rest) && diskOk(r));
  const titleMatches = exactTitle.length > 0
    ? exactTitle
    : rows.filter((r) => containsCI(r.title, rest) && diskOk(r));

  const candidates: DiskCandidate[] = [];
  const seen = new Set<string>();
  for (const r of [...exactMatches, ...titleMatches]) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      candidates.push(r);
    }
  }
  // Sorted for a stable, human-readable numbered list (the script's job) --
  // independent of which rule matched a given row.
  candidates.sort((a, b) => a.title.localeCompare(b.title) || a.diskNo - b.diskNo);

  if (candidates.length === 1) return { kind: 'one', disk: candidates[0] };
  if (candidates.length > 1) return { kind: 'many', disks: candidates };
  return { kind: 'none' };
}
