// Row selection for a Files pane: a cursor, an anchor for shift-ranges, and the picked rows. Client-safe.
export type Selection = { anchor: number | null; cursor: number; picked: ReadonlySet<number> };

export const EMPTY_SELECTION: Selection = { anchor: null, cursor: 0, picked: new Set<number>() };

function range(a: number, b: number): Set<number> {
  const out = new Set<number>();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
  return out;
}

export function togglePick(s: Selection, index: number): Selection {
  const picked = new Set(s.picked);
  if (!picked.delete(index)) picked.add(index);
  return { anchor: index, cursor: index, picked };
}

export function selectClick(s: Selection, index: number, mods: { shift: boolean; toggle: boolean }): Selection {
  if (mods.shift && s.anchor !== null) return { anchor: s.anchor, cursor: index, picked: range(s.anchor, index) };
  if (mods.toggle) return togglePick(s, index);
  return { anchor: index, cursor: index, picked: new Set([index]) };
}

/** Arrow keys: clamp to the list; with `extend` the picked range grows from the anchor, otherwise the pick follows. */
export function moveCursor(s: Selection, delta: number, count: number, extend: boolean): Selection {
  const cursor = count <= 0 ? 0 : Math.min(count - 1, Math.max(0, s.cursor + delta));
  if (count <= 0) return { ...s, cursor };
  if (extend) {
    const anchor = s.anchor ?? s.cursor;
    return { anchor, cursor, picked: range(anchor, cursor) };
  }
  return { anchor: cursor, cursor, picked: new Set([cursor]) };
}

/** The bank's All (Files 2 §2.3): every drawn row picked, the cursor on the first; nothing in an empty pane. */
export function selectAll(count: number): Selection {
  return count <= 0 ? EMPTY_SELECTION : { anchor: 0, cursor: 0, picked: range(0, count - 1) };
}
