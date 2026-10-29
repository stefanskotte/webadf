// Where the retired Upload page's URLs go (Files spec 2026-10-29 §5.3, increment 3 R10). CLIENT-SAFE.
import { filesHrefForBoard } from './path';

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v ? v : null);

/**
 * `/ingest` -> `/files`; `?board=X` (a send's "See queue", the device card's send line) -> STASH: beside NET:/X with
 * the queue active; `?from=X` (the card's "N files from the Amiga") -> the same panes with STASH: active, where the
 * Amiga's files land. `board` wins when both are given (the old page opened To the Amiga then). An X that is not a
 * board still redirects: the pane says the place no longer exists. A repeated parameter names no one board.
 */
export function ingestRedirect(sp: Record<string, string | string[] | undefined>): string {
  const board = one(sp.board);
  if (board) return filesHrefForBoard(board, 'right');
  const from = one(sp.from);
  if (from) return filesHrefForBoard(from, 'left');
  return '/files';
}
