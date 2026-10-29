// Files from the computer to a board's queue (Files increment 3, C2 and R7): what a drop on a NET:/<board> pane (and
// Task 3's Send drop zone) does. The whole drop is checked against the board's queue (its NET: listing's `queue`) and
// the 4 MB cap first and refused whole when it does not fit; then one POST /api/transfers?deviceId=&name=<relative
// path> per file, as the Send card always sent them (the route cleans the path). CLIENT-SAFE: no server imports.
import { sendErrorText } from '@/lib/send-ui';
import { planNetSend } from './net-rules';
import { refusalWords } from './words';

export const NOTHING_TO_SEND = 'Nothing to send — the drop held no files.';
const NOT_FINISHED = 'The upload did not finish. Check the connection and try again.';
const SIGNED_OUT = 'Signed out — sign in again';

/** Why these files cannot go to the board whose queue holds `queue` now, in words; null when they fit. */
export function netDropRefusal(files: { path: string; size: number }[], queue: { files: number; bytes: number }): string | null {
  if (files.length === 0) return NOTHING_TO_SEND;
  const plan = planNetSend(files.map((f) => f.size), queue);
  if (plan.ok) return null;
  const path = plan.index === undefined ? '' : files[plan.index].path;
  if (plan.why === 'queue_full') return refusalWords('queue_full');
  if (plan.why === 'too_large') return refusalWords('too_large', `${path} is over 4 MB`);
  return `${path} is empty — nothing to send.`;
}

export type NetSendResult = {
  queued: number;
  /** Files the server refused one by one (a name the Amiga cannot take), or whose upload broke off. */
  failed: { path: string; why: string }[];
  /** The words of an answer that stopped the rest (the queue filled in a race, signed out); null when all were tried. */
  stopped: string | null;
};

/** Each file in turn to the board `deviceId`; a race that fills the queue stops the rest, so a drop half-queues only then. */
export async function sendToBoard(deviceId: string, files: { path: string; file: File }[],
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): Promise<NetSendResult> {
  const out: NetSendResult = { queued: 0, failed: [], stopped: null };
  for (const { path, file } of files) {
    let res: Response;
    try {
      res = await fetchImpl(`/api/transfers?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(path)}`,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    } catch {
      out.failed.push({ path, why: NOT_FINISHED });
      continue;
    }
    if (res.redirected) { out.stopped = SIGNED_OUT; break; }
    if (res.ok) { out.queued++; continue; }
    const code = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    if (code === 'queue_full') { out.stopped = refusalWords('queue_full'); break; }
    if (code === 'no_device') { out.stopped = sendErrorText(code, res.status); break; }
    out.failed.push({ path, why: sendErrorText(code, res.status) });
  }
  return out;
}
