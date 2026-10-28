// The words for a refused Files operation. Client-safe: types only.
import type { RefusalCode } from './types';

/** `detail` is whatever the engine sent (ops.ts); every code reads naturally with or without it. */
export function refusalWords(code: RefusalCode, detail?: string): string {
  switch (code) {
    case 'disk_full': return detail ? `Not enough room on the disk — ${detail}` : 'Not enough room on the disk.';
    case 'read_only': return detail
      ? `This disk is in a drive (${detail}). Eject it to change it.` : 'This disk is in a drive. Eject it to change it.';
    case 'mounted': return detail
      ? `This disk is in a drive (${detail}). Eject it to change it.` : 'This disk is in a drive. Eject it to change it.';
    case 'conflict': return 'The disk changed — the pane has been refreshed.';
    case 'cycle': return 'A folder cannot go inside itself.';
    case 'bad_name': return detail === 'comment'
      ? 'Comments can only use Latin-1 characters.'
      : 'AmigaDOS names are at most 30 characters, without : or /.';
    case 'name_exists':
      if (detail === 'same file') return 'That is the same file.';
      if (detail === 'two sources share a name') return 'Two of the chosen items have the same name.';
      return 'Something with that name is already there.';
    case 'comment_too_long': return 'Comments are at most 79 characters.';
    case 'not_found': return 'That is no longer there.';
    case 'hfe_read_only': return 'HFE disks are read-only.';
    case 'no_filesystem': return 'This disk has no AmigaDOS filesystem.';
    case 'unsupported': return detail ? `Not supported: ${detail}.` : 'That is not supported.';
    case 'blob_unavailable': return 'The disk image could not be read. Try again in a moment.';
    case 'failed': return detail ? `Something went wrong: ${detail}.` : 'Something went wrong.';
  }
}
