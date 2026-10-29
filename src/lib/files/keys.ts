// Keyboard commands for the Files panes. Client-safe: no DOM types needed.
export type FilesCommand =
  | 'up' | 'down' | 'pick' | 'open' | 'parent' | 'switch' | 'copy' | 'move' | 'makedir' | 'rename' | 'delete' | 'find';

const KEYS: Record<string, FilesCommand> = {
  ArrowUp: 'up', ArrowDown: 'down', ' ': 'pick', Enter: 'open', Backspace: 'parent', Tab: 'switch',
  F5: 'copy', F6: 'move', F7: 'makedir', F2: 'rename', Delete: 'delete', '/': 'find',
};

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** The command a key press means, or null when the key belongs to something else (a field, a dialog, a shortcut). */
export function commandFor(e: {
  key: string; target: { tagName?: string; isContentEditable?: boolean } | null;
  dialogOpen: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean;
}): FilesCommand | null {
  if (e.dialogOpen || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.target && (e.target.isContentEditable || TYPING.has((e.target.tagName ?? '').toUpperCase()))) return null;
  return Object.hasOwn(KEYS, e.key) ? KEYS[e.key] : null;
}
