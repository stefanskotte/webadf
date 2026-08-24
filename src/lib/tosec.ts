export interface ParsedName {
  title: string;
  year: number | null;
  publisher: string | null;
  diskNo: number | null;
  diskCount: number | null;
  flags: string[];
  sortTitle: string;
}

const ARTICLES = ['the', 'a', 'an'];

export function makeSortTitle(title: string): string {
  const lower = title.toLowerCase().trim();
  for (const a of ARTICLES) {
    if (lower.startsWith(`${a} `)) return `${lower.slice(a.length + 1)}, ${a}`;
  }
  return lower;
}

export function parseTosecName(filename: string): ParsedName {
  const stem = filename.replace(/\.(adf|dsk|adz|dms)$/i, '');

  const flags = [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  const parens = [...stem.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);

  let year: number | null = null;
  let publisher: string | null = null;
  let diskNo: number | null = null;
  let diskCount: number | null = null;

  for (const p of parens) {
    const disk = p.match(/^disk\s+(\d+)(?:\s+of\s+(\d+))?$/i);
    if (disk) {
      diskNo = Number(disk[1]);
      diskCount = disk[2] ? Number(disk[2]) : null;
      continue;
    }
    if (year === null && /^\d{4}$/.test(p)) { year = Number(p); continue; }
    if (year !== null && publisher === null) publisher = p;
  }

  // Everything before the first bracket of either kind is the title.
  let title = stem.split(/\s*[([]/)[0].trim();

  // Only when no "(Disk N of M)" clause was present, honour a trailing -N.
  // Split on the FINAL dash so "Example - Space Unknown-2" groups correctly.
  if (diskNo === null) {
    const trailing = title.match(/^(.*)-(\d+)$/);
    if (trailing && /\s-\d+$|\S-\d+$/.test(title) && trailing[1].trim().length > 0) {
      const candidate = Number(trailing[2]);
      // A hyphenated word like "Project-X" has a non-numeric tail and never reaches
      // here; guard against absurd disk numbers from titles such as "Turrican-2000".
      if (candidate >= 1 && candidate <= 99) {
        title = trailing[1].trim();
        diskNo = candidate;
      }
    }
  }

  // Same precedence as the trailing -N rule above: only when no "(Disk N of M)"
  // clause (and no trailing -N) already set diskNo. Two more non-TOSEC naming
  // conventions found in real-world archives: "Name_D<N>" and "Name_#<N>".
  // Both require a `_` separator so ordinary titles are never mistaken for one
  // ("Project-X" has no underscore and never reaches here).
  if (diskNo === null) {
    const dSuffix = title.match(/^(.+)_D(\d+)$/i);
    if (dSuffix) {
      const candidate = Number(dSuffix[2]);
      if (candidate >= 1 && candidate <= 99) {
        title = dSuffix[1];
        diskNo = candidate;
      }
    }
  }

  if (diskNo === null) {
    const hashSuffix = title.match(/^(.+)_#(\d+)$/);
    if (hashSuffix) {
      const candidate = Number(hashSuffix[2]);
      if (candidate >= 1 && candidate <= 99) {
        title = hashSuffix[1];
        diskNo = candidate;
      }
    }
  }

  return { title, year, publisher, diskNo, diskCount, flags, sortTitle: makeSortTitle(title) };
}
