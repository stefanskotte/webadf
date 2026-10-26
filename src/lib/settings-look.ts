// Settings' look rules (Phase C5 spec §1.1, §2): pure and client-safe.

export type RadioMods = { alt?: boolean; ctrl?: boolean; meta?: boolean };

/**
 * The radio a key moves to in a roving radiogroup (spec §1.1): Right/Down next, Left/Up previous (wrapping), Home/End
 * first/last. Null for any other key, and for any key held with Alt, Ctrl or Meta (those belong to the browser).
 */
export function radioAfterKey<V>(values: readonly V[], current: V, key: string, mods: RadioMods = {}): V | null {
  if (mods.alt || mods.ctrl || mods.meta || values.length === 0) return null;
  if (key === 'Home') return values[0];
  if (key === 'End') return values[values.length - 1];
  const dir = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (!dir) return null;
  const at = values.indexOf(current);
  if (at < 0) return values[dir > 0 ? 0 : values.length - 1];
  return values[(at + dir + values.length) % values.length];
}

export type PrefsSaveState = 'saved' | 'saving' | 'failed';

/** The Preferences save line (Ruling 7): A2's words, the board's dot. */
export function prefsStateLook(s: PrefsSaveState): { text: string; dot: string; fg: string } {
  if (s === 'saving') return { text: 'Saving…', dot: 'var(--fetch-dot)', fg: 'var(--muted)' };
  if (s === 'failed') return { text: "Couldn't save. Try again", dot: 'var(--danger-fg)', fg: 'var(--danger-fg)' };
  return { text: 'All changes saved', dot: 'var(--online-dot)', fg: 'var(--success-fg)' };
}

/** A Settings card (spec §2.1): surface, a 1px line ring, 20px corners; clear of the top when it is the hash target. */
export const SETTINGS_CARD = 'scroll-mt-6 rounded-[20px] p-5 sm:p-6';
export const CARD_STYLE = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' } as const;
/** Every card's h2: a programmatic focus target (the section list, Sign out everywhere else) with a visible ring. */
export const SETTINGS_H2 =
  'rounded-[6px] text-[17px] font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)';
/** Words left, control right from sm; stacked (words, then control) below it. */
export const SETTINGS_ROW = 'grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-5';
export const FIELD =
  'h-10 w-full rounded-[10px] border px-3 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
export const FIELD_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;
export const OUTLINE_BTN =
  'h-9 shrink-0 justify-self-start rounded-[9px] border px-3 text-[13px] font-medium disabled:opacity-60 aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) max-sm:min-h-11';
export const OUTLINE_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;
/** `text-white` is the hover rule's key for dark buttons (globals.css); the inline colour wins over it. */
export const INK_BTN =
  'h-9 rounded-[9px] px-3.5 text-[13px] font-semibold text-white disabled:opacity-60 aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) max-sm:min-h-11';
export const INK_STYLE = { background: 'var(--ink)', color: 'var(--surface)' } as const;
