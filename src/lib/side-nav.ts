/**
 * The section a side list marks current (C5 spec §1.2, Ruling 2). Before any scroll (`visible` null): the hash
 * target if it is one of `ids`, else the first. After: the topmost section in view, in list order; null when none is
 * in view, so the caller keeps what it had.
 */
export function currentSection(ids: readonly string[], visible: ReadonlySet<string> | null, hash: string): string | null {
  if (ids.length === 0) return null;
  if (visible === null) {
    const target = hash.replace(/^#/, '');
    return ids.includes(target) ? target : ids[0];
  }
  return ids.find((id) => visible.has(id)) ?? null;
}

/** The section a URL hash names, if it is one of `ids`; null otherwise (a hashchange to anything else changes nothing). */
export function sectionForHash(ids: readonly string[], hash: string): string | null {
  const target = hash.replace(/^#/, '');
  return ids.includes(target) ? target : null;
}
