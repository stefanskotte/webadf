import { makeSortTitle, parseTosecName } from '@/lib/tosec';

export interface RederiveInput {
  tosec: { title: string; year: number | null; publisher: string | null } | null;
  filename: string | null;
  fallbackTitle: string;
}
export interface Rederived {
  title: string; sortTitle: string; year: number | null; publisher: string | null;
  metadataSource: 'tosec' | 'filename';
}

/** The next machine source below Demozoo (spec §6.3): TOSEC, else the filename. */
export function rederiveMachineTitle(i: RederiveInput): Rederived {
  if (i.tosec) {
    return { title: i.tosec.title, sortTitle: makeSortTitle(i.tosec.title), year: i.tosec.year,
             publisher: i.tosec.publisher, metadataSource: 'tosec' };
  }
  const p = parseTosecName(i.filename ?? i.fallbackTitle);
  return { title: p.title, sortTitle: p.sortTitle, year: p.year, publisher: p.publisher, metadataSource: 'filename' };
}
