// How a refusal over a held disk is worded, in ONE place. No imports, so the
// client grid can use it as safely as the server routes: the server sends
// `mountedReason(name)` as the 409's `reason`, and every sentence shown to a
// person -- the files page, the library card and its toast -- is built by
// `ejectMessage` around either that reason or a freshly made one. Reword
// both together: ejectMessage reads "This disk is <reason>".

/** The 409 `reason` for a disk a device holds: `mounted on "<name>"`. */
export function mountedReason(deviceName: string): string {
  return `mounted on "${deviceName}"`;
}

/** Whether a server `reason` is a `mountedReason` -- the test lives here with the format. */
export function isMountedReason(reason: string): boolean {
  return reason.startsWith('mounted on ');
}

/**
 * The sentence shown for a held disk, around a `mountedReason` string. With
 * no `action` it ends "eject it there first." (the file-edit toast).
 */
export function ejectMessage(reason: string, action?: 'editing' | 'renaming'): string {
  return `This disk is ${reason} — eject it there ${action ? `before ${action}` : 'first'}.`;
}
