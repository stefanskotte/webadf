/**
 * NFC tap-to-mount's decisions, pure (spec 2026-09-25 §5). The routes and the
 * CLI do the I/O; everything that decides lives here so it can be tested
 * without a database.
 */

/** The shape stableId() produces (src/lib/ingest.ts). Every disk insert uses
 *  it (checked 2026-09-25); a new creation path that does not must widen this. */
export const DISK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const TAP_MIN_INTERVAL_MS = 1000;
export const NFC_WRITE_TTL_MS = 120_000;

export type TapOutcome = 'mounting' | 'already' | 'not_found' | 'too_long' | 'ignored' | 'single' | 'nothing_mounted';

/** D2: a different disk swaps, the desired one is a no-op, and a burst is ignored. */
export function decideTap(
  row: { desiredDiskId: string | null; lastTapAt: Date | null },
  diskId: string, now: Date,
): 'ignored' | 'already' | 'mount' {
  if (row.lastTapAt && now.getTime() - row.lastTapAt.getTime() < TAP_MIN_INTERVAL_MS) return 'ignored';
  if (row.desiredDiskId === diskId) return 'already';
  return 'mount';
}

/**
 * What the poll tells the board about writing, given the cursor it sent.
 * null = nothing to say (up to date, ahead of us, or never asked). A request
 * that is cancelled, expired or already answered is still delivered -- as
 * diskId null, "disarm" -- so the board's cursor catches up and the hold
 * does not keep releasing forever.
 */
export function nfcWriteForPoll(
  row: {
    nfcWriteSeq: number; nfcWriteDiskId: string | null; nfcWriteKind: string;
    nfcWriteExpiresAt: Date | null; nfcWriteResultSeq: number | null;
  },
  ack: number, now: Date,
): { seq: number; diskId: string | null; kind: 'disk' | 'next' } | null {
  if (row.nfcWriteSeq <= ack) return null;
  const next = row.nfcWriteKind === 'next';
  const live = (next || row.nfcWriteDiskId !== null)
    && row.nfcWriteExpiresAt !== null && now.getTime() <= row.nfcWriteExpiresAt.getTime()
    && row.nfcWriteResultSeq !== row.nfcWriteSeq;
  if (!live) return { seq: row.nfcWriteSeq, diskId: null, kind: 'disk' };
  return next ? { seq: row.nfcWriteSeq, diskId: null, kind: 'next' } : { seq: row.nfcWriteSeq, diskId: row.nfcWriteDiskId, kind: 'disk' };
}

/** Only the first answer to the CURRENT request counts. */
export function shouldStoreWriteResult(
  row: { nfcWriteSeq: number; nfcWriteResultSeq: number | null }, reportSeq: number,
): boolean {
  return reportSeq === row.nfcWriteSeq && row.nfcWriteResultSeq !== reportSeq;
}

/**
 * Which board a web write goes to (the fob button). `devices` is the caller's
 * OWN org's boards, so a named id that is not in it -- another org's or one
 * that never existed -- is not_found either way. Only a reader the board has
 * reported 'present' counts: 'absent' and NULL (firmware older than the
 * report) both mean nothing would ever answer the request.
 */
export function chooseNfcDevice<D extends { id: string; name: string; nfcReader: string | null }>(
  devices: D[], deviceId?: string,
): { ok: true; device: D } | { ok: false; error: 'not_found' | 'no_reader' | 'device_required' } {
  if (deviceId !== undefined) {
    const d = devices.find((x) => x.id === deviceId);
    if (!d) return { ok: false, error: 'not_found' };
    return d.nfcReader === 'present' ? { ok: true, device: d } : { ok: false, error: 'no_reader' };
  }
  const readers = devices.filter((d) => d.nfcReader === 'present');
  if (readers.length === 0) return { ok: false, error: 'no_reader' };
  // Guessing between two readers would arm a board the person is not
  // standing at; the dialog asks instead.
  if (readers.length > 1) return { ok: false, error: 'device_required' };
  return { ok: true, device: readers[0] };
}

/** The boards that can write a Next-disk card: a reader present AND a build
 *  that reports `preload` (1.6.0+, preloadState NOT NULL -- a 1.6.0 board with
 *  nothing preloaded reports null, stored as 'none'). Firmware 1.3.0 to 1.5.1
 *  has a reader but reads the card's request (diskId: null) as a disarm, so
 *  offering it there would only count down to "expired". */
export function nextCardWriters<D extends { id: string; name: string; nfcReader: string | null; preloadState: string | null }>(
  devs: D[],
): { id: string; name: string }[] {
  return devs
    .filter((d) => d.nfcReader === 'present' && d.preloadState !== null)
    .map(({ id, name }) => ({ id, name }));
}

export type NfcWriteStatus =
  | { state: 'waiting' }
  | { state: 'ok'; uid: string | null }
  | { state: 'failed'; reason: string; uid: string | null }
  | { state: 'superseded' }
  | { state: 'expired' };

/**
 * Where ONE write request stands, for the web dialog polling it. An answer
 * stored for `seq` wins over everything else: a cancel moves the cursor but
 * leaves the answer readable (cancelNfcWrite), and a board may answer just
 * after the expiry -- in both cases the tag really was written. Without an
 * answer, a cursor past `seq` means something else (a newer request, from
 * the CLI or another tab, or a cancel) replaced it. null: `seq` was never
 * issued on this board.
 */
export function nfcWriteStatus(
  row: {
    nfcWriteSeq: number; nfcWriteExpiresAt: Date | null;
    nfcWriteResultSeq: number | null; nfcWriteResult: string | null; nfcWriteResultUid: string | null;
  },
  seq: number, now: Date,
): NfcWriteStatus | null {
  if (row.nfcWriteResultSeq === seq && row.nfcWriteResult) {
    return row.nfcWriteResult === 'ok'
      ? { state: 'ok', uid: row.nfcWriteResultUid }
      : { state: 'failed', reason: row.nfcWriteResult, uid: row.nfcWriteResultUid };
  }
  if (seq > row.nfcWriteSeq) return null;
  if (seq < row.nfcWriteSeq) return { state: 'superseded' };
  if (row.nfcWriteExpiresAt === null || now.getTime() > row.nfcWriteExpiresAt.getTime()) return { state: 'expired' };
  return { state: 'waiting' };
}

/** A tag uid as a person reads it off a tag reader app: "24 19 B6 01". The
 *  board sends contiguous upper-case hex, or "none" when it had no uid. */
export function formatTagUid(uid: string | null): string | null {
  const hex = (uid ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length === 0 || uid?.toLowerCase() === 'none') return null;
  return hex.match(/.{1,2}/g)!.join(' ');
}

/** The board's failure reasons (firmware nfc_reader.c: locked, moved,
 *  verify) as plain words. An unknown one is shown verbatim, not hidden. */
export function writeFailureText(reason: string): string {
  // fw 1.18.2 adds the PN532's status byte and the command that drew it: "locked:0x14@A2". The words stay the
  // word's; the code follows, for whoever reads it out to us.
  const m = /^([^:]+):(0x[0-9A-Fa-f]{2})@([0-9A-Fa-f]{2})$/.exec(reason);
  if (m) return `${writeFailureText(m[1]!)} (reader code ${m[2]} on ${m[3]})`;
  switch (reason) {
    case 'locked': return 'Locked tag — it cannot be written.';
    case 'moved': return 'Tag moved — hold it still until the board confirms.';
    case 'verify': return 'Verify failed — the tag read back differently.';
    default: return `Write failed (${reason}).`;
  }
}

/**
 * The tap outcome for a mount setDesired refused. hd_unsupported goes out as
 * 'too_long': the only boards ever refused an HD disk run firmware older than
 * 1.4.0 (or built with WF_DRIVE_ID off), and device_client.c turns an outcome
 * word it does not know into "no answer" -- the silent drop HD spec §4.3
 * forbids. 'too_long' is a refusal those builds show ("Tag: tracks too
 * long"), and its remedy is the same one: update the board's firmware.
 */
export function tapRefusalOutcome(
  reason: 'not_found' | 'track_too_long' | 'hd_unsupported',
): TapOutcome {
  return reason === 'not_found' ? 'not_found' : 'too_long';
}
