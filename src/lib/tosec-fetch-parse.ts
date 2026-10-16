/** tosecdev.org's pages, as measured 2026-10-16 (spec P3 "Facts"). Fails to null, never guesses. */
export const TOSEC_DOWNLOADS = 'https://www.tosecdev.org/downloads';
export const AMIGA_ADF_DAT = /^TOSEC\/Commodore Amiga - .* - \[ADF\] \(TOSEC-v[^)]*\)\.dat$/;

export function newestRelease(html: string): { path: string; date: string } | null {
  let best: { path: string; date: string } | null = null;
  for (const m of html.matchAll(/href="(\/downloads\/category\/\d+-(\d{4}-\d{2}-\d{2}))"/g)) {
    if (!best || m[2] > best.date) best = { path: m[1], date: m[2] };
  }
  return best;
}

export function completePackLink(html: string, base = 'https://www.tosecdev.org'): string | null {
  const m = /href="([^"]*\?download=\d+:tosec-dat-pack-complete[^"]*)"/.exec(html);
  return m ? new URL(m[1].replace(/&amp;/g, '&'), base).toString() : null;
}
