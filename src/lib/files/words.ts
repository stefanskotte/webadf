// The words for a refused Files operation. Client-safe: types only.
import { isMountedReason } from '../mount-wording';
import type { RefusalCode } from './types';

const REMOVE_FAILED = 'copied, but the original could not be removed';
/** = StashBusy's message (stash.ts, server-only): a STASH: file the board has not finished sending. */
const STILL_ARRIVING = 'still arriving from the Amiga';

/** `detail` is whatever the engine sent (ops.ts); every code reads naturally with or without it. */
export function refusalWords(code: RefusalCode, detail?: string): string {
  // A move whose copy landed but whose removal was refused: the code is the removal's.
  if (detail === REMOVE_FAILED) return `Copied, but the original could not be removed — ${refusalWords(code)}`;
  switch (code) {
    case 'disk_full': return detail ? `Not enough room on the disk — ${detail}` : 'Not enough room on the disk.';
    case 'read_only':
      if (detail === 'hfe_read_only' || detail === 'no_filesystem') return refusalWords(detail);
      if (detail === 'archive') return 'Archives are read-only — copy files out of them.';
      if (detail && !isMountedReason(detail)) return 'This disk is read-only.';
      return refusalWords('mounted', detail);
    case 'mounted': return detail
      ? `This disk is in a drive (${detail}). Eject it to change it.` : 'This disk is in a drive. Eject it to change it.';
    case 'conflict': return 'The disk changed — the pane has been refreshed.';
    case 'cycle': return 'A folder cannot go inside itself.';
    case 'bad_name':
      if (detail === 'comment') return 'Comments can only use Latin-1 characters.';
      if (detail === 'empty') return 'Type a name.';
      if (detail === 'too-long') return 'AmigaDOS names are at most 30 characters.';
      if (detail === 'bad-char') return 'Names cannot contain : or /, or characters an Amiga cannot show.';
      return 'AmigaDOS names are at most 30 characters, without : or /.';
    case 'name_exists':
      if (detail === 'same file') return 'That is the same file.';
      if (detail === 'two sources share a name') return 'Two of the chosen items have the same name.';
      return 'Something with that name is already there.';
    case 'comment_too_long': return 'Comments are at most 79 characters.';
    case 'not_found': return 'That is no longer there.';
    case 'hfe_read_only': return 'HFE disks are read-only.';
    case 'no_filesystem': return 'This disk has no AmigaDOS filesystem.';
    case 'unsupported':
      if (detail === STILL_ARRIVING) return 'That is still arriving from the Amiga.';
      return detail ? `Not supported: ${detail}.` : 'That is not supported.';
    case 'blob_unavailable': return 'The disk image could not be read. Try again in a moment.';
    case 'failed': return detail ? `Something went wrong: ${detail}.` : 'Something went wrong.';
    case 'stash_full': return 'STASH: holds 500 files / 256 MB; delete some first.';
    case 'too_large': return detail ? `Too large — ${detail}.` : 'That file is too large.';
    case 'archive_unreadable': return "Can't open this archive. You can still download it.";
    case 'not_a_disk_image': return detail
      ? `Not a disk image the library takes — ${detail}.` : 'Only disk images (ADF, ADZ, DMS, DMZ, HFE) go into the library.';
  }
}
