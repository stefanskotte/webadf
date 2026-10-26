/**
 * A drop card's hint on a phone keeps its first sentence (C7 spec §7, Ruling 19: "today's hint words, shortened only
 * by dropping the second sentence"). `rest` is '' when there is only one.
 */
export function splitHint(text: string): { first: string; rest: string } {
  const t = text.trim();
  const m = /^([\s\S]+?[.!?])\s+([\s\S]+)$/.exec(t);
  return m ? { first: m[1], rest: m[2] } : { first: t, rest: '' };
}
