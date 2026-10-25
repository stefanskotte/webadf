import { HELP_ORDER, HELP_TOPICS, type HelpTopicId } from './topics';

export const HELP_HIT_LIMIT = 3;

/**
 * Help topics for the header search (A3): every word of the query must appear in a topic's title or its short
 * description, case aside. Matched in the browser -- the topics ship with the app, so there is no server round trip.
 * Title matches first, then the Help page's own order. Two characters at least, like the server's search.
 */
export function matchHelpTopics(raw: string, limit = HELP_HIT_LIMIT): HelpTopicId[] {
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.join('').length < 2) return [];
  const inTitle: HelpTopicId[] = [];
  const inShort: HelpTopicId[] = [];
  for (const id of HELP_ORDER) {
    const t = HELP_TOPICS[id];
    const title = t.title.toLowerCase();
    const all = `${title} ${t.short.toLowerCase()}`;
    if (!words.every((w) => all.includes(w))) continue;
    (words.every((w) => title.includes(w)) ? inTitle : inShort).push(id);
  }
  return [...inTitle, ...inShort].slice(0, limit);
}

/**
 * The Help page's filter (C5 spec §3.4, Ruling 15): the header search's matcher with no limit. `active` once the
 * query has two characters (A3's rule); an active filter with no ids is a real "no topic matches" answer.
 */
export function filterHelpTopics(raw: string): { active: boolean; ids: ReadonlySet<HelpTopicId> } {
  const active = raw.toLowerCase().split(/\s+/).filter(Boolean).join('').length >= 2;
  return { active, ids: new Set(active ? matchHelpTopics(raw, Infinity) : []) };
}
