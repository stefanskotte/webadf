// src/lib/files/bank.ts
// The button bank under both panes (Files 2 spec §2.3): six columns by three rows, in Directory Opus's manner. Every
// command acts on the source pane; Copy and Move go source → destination, so no label carries an arrow. CLIENT-SAFE.
export type BankCommand =
  | 'all' | 'copy' | 'makedir' | 'createadf' | 'info' | 'download'
  | 'none' | 'move' | 'rename' | 'addlib' | 'protect' | 'filter'
  | 'parent' | 'root' | 'swap' | 'showinfo' | 'delete';

export const BANK_GRID: readonly (BankCommand | null)[] = [
  'all', 'copy', 'makedir', 'createadf', 'info', 'download',
  'none', 'move', 'rename', 'addlib', 'protect', 'filter',
  'parent', 'root', 'swap', 'showinfo', null, 'delete',
];

export const BANK_LABEL: Record<BankCommand, string> = {
  all: 'All', copy: 'Copy', makedir: 'Makedir', createadf: 'Create ADF…', info: 'Info', download: 'Download',
  none: 'None', move: 'Move', rename: 'Rename', addlib: 'Add to library', protect: 'Protect', filter: 'Filter…',
  parent: 'Parent', root: 'Root', swap: 'Swap', showinfo: 'Show .info', delete: 'Delete',
};
