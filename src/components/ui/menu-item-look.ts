/**
 * The keyboard/hover highlight of a menu item. The stock `focus:bg-accent` is `--surface-2` on a `--surface` popup,
 * about 1.1:1, so a person arrowing through the menu could not see which item Enter would fire. The fill is
 * `--track` and an inset 2px ring in `--muted-2` (5.58 on --surface, 4.69 on --track) carries the 3:1 cue.
 * The classes are written out in full: Tailwind finds a class by scanning source text, not by running code.
 */
export const MENU_ITEM_RING_TOKEN = '--muted-2';

export const MENU_ITEM_HIGHLIGHT =
  'data-highlighted:bg-[var(--track)] data-highlighted:shadow-[inset_0_0_0_2px_var(--muted-2)] '
  + 'focus:bg-[var(--track)] focus:shadow-[inset_0_0_0_2px_var(--muted-2)] '
  + 'data-[variant=destructive]:data-highlighted:bg-[var(--track)] '
  + 'data-[variant=destructive]:data-highlighted:shadow-[inset_0_0_0_2px_var(--muted-2)] '
  + 'data-[variant=destructive]:focus:bg-[var(--track)] '
  + 'data-[variant=destructive]:focus:shadow-[inset_0_0_0_2px_var(--muted-2)]';
