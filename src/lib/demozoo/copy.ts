// Postgres COPY text format, as written by pg_dump into Demozoo's export.
// https://www.postgresql.org/docs/current/sql-copy.html  ("Text Format")
// Fields are tab-separated, \N is NULL, and backslash introduces an escape.

const SIMPLE: Record<string, string> = {
  b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\',
};

export function decodeCopyField(raw: string): string | null {
  if (raw === '\\N') return null;
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\' || i === raw.length - 1) { out += c; continue; }
    const n = raw[i + 1];
    if (n in SIMPLE) { out += SIMPLE[n]; i++; continue; }
    const oct = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
    if (oct) { out += String.fromCharCode(parseInt(oct[0], 8)); i += oct[0].length; continue; }
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(raw.slice(i + 1));
    if (hex) { out += String.fromCharCode(parseInt(hex[1], 16)); i += hex[0].length; continue; }
    out += n; i++;   // any other escaped character stands for itself
  }
  return out;
}

export function parseCopyHeader(line: string): { table: string; columns: string[] } | null {
  const m = /^COPY ([\w.]+) \((.*)\) FROM stdin;$/.exec(line);
  if (!m) return null;
  return {
    table: m[1].replace(/^public\./, ''),
    columns: m[2].split(', ').map((c) => c.replace(/^"|"$/g, '')),
  };
}

export interface CopyRow { table: string; row: Record<string, string | null> }

/**
 * Rows of the wanted tables, in dump order. An unwanted block is skipped to
 * its terminator, so a data line that happens to look like a COPY header can
 * never open a block.
 */
export async function* readCopyBlocks(
  lines: AsyncIterable<string>, want: ReadonlySet<string>,
): AsyncGenerator<CopyRow> {
  let current: { table: string; columns: string[] } | null = null;
  let skipping = false;
  for await (const line of lines) {
    if (skipping) { if (line === '\\.') skipping = false; continue; }
    if (current === null) {
      const h = parseCopyHeader(line);
      if (!h) continue;
      if (want.has(h.table)) current = h; else skipping = true;
      continue;
    }
    if (line === '\\.') { current = null; continue; }
    const values = line.split('\t');
    const row: Record<string, string | null> = {};
    current.columns.forEach((col, i) => { row[col] = decodeCopyField(values[i] ?? '\\N'); });
    yield { table: current.table, row };
  }
}
