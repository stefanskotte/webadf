'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { MountAction } from '@/components/games/mount-action';
import { useSendBoard } from '@/components/send/use-send-board';
import type { MountChoice } from '@/lib/mount-choice';
import { remoteErrorText } from '@/lib/remote/copy';
import { sendErrorText, type SendContext } from '@/lib/send-ui';

const OUTLINE = 'btn-like inline-flex h-[38px] shrink-0 items-center rounded-[10px] border px-3 text-[13px] font-medium disabled:opacity-50 max-sm:min-h-11';
const OUTLINE_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' };

/** The remote routes' own codes, worded by remoteErrorText; everything else is a send refusal (send-ui.ts). */
const REMOTE_CODES = new Set(['ended', 'unreachable', 'protocol', 'not_shared', 'not_found', 'rate_limited', 'too_large', 'mismatch']);

type Where = { libraryId: string; titleId: string; diskId: string; host: string };
const base = (w: Where) => `/api/remote/${encodeURIComponent(w.libraryId)}/disks/${encodeURIComponent(w.diskId)}`;

async function errorOf(res: Response, host: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown; host?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : undefined;
  return code && REMOTE_CODES.has(code)
    ? remoteErrorText(code, typeof body?.host === 'string' ? body.host : host)
    : sendErrorText(code, res.status);
}

/** The server's name for the file (download-name.ts contentDisposition's RFC 5987 form), else the fallback. */
function savedName(header: string | null, fallback: string): string {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '');
  if (!m) return fallback;
  try { return decodeURIComponent(m[1]); } catch { return fallback; }
}

/** Send to Amiga (spec §4.2): the owner asked again, then the whole disk queued as <name>.adf, as from a local disk. */
function RemoteSend({ where, ctx, label }: { where: Where; ctx: SendContext; label: string }) {
  const router = useRouter();
  const [board] = useSendBoard(ctx.targets, ctx.now);
  const [busy, setBusy] = useState(false);
  if (!board) return null;
  async function send() {
    if (!board) return;
    const name = ctx.targets.find((t) => t.id === board)?.name ?? 'the board';
    setBusy(true);
    try {
      const res = await fetch(`${base(where)}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titleId: where.titleId, deviceId: board }),
      });
      if (!res.ok) { toast.error(`Could not send ${label}`, { description: await errorOf(res, where.host) }); return; }
      toast.success(`Queued for ${name}`, {
        description: label, action: { label: 'See queue', onClick: () => router.push(`/ingest?board=${encodeURIComponent(board)}`) },
      });
    } catch {
      toast.error(`Could not send ${label}`, { description: 'Check the connection and try again.' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" disabled={busy} onClick={() => void send()} data-testid={`remote-send-${where.diskId}`}
            className={OUTLINE} style={OUTLINE_STYLE}>
      {busy ? 'Sending…' : 'Send to Amiga'}
    </button>
  );
}

/**
 * Download (spec §4.2): fetched through this server from the owner and checked, never kept here. Fetched by script,
 * not a plain link, so a refusal ("No longer shared", "Can't reach <host>") is a toast instead of a page of JSON.
 */
function RemoteDownload({ where, filename }: { where: Where; filename: string }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`${base(where)}/download?titleId=${encodeURIComponent(where.titleId)}`);
      if (!res.ok) { toast.error('Could not download', { description: await errorOf(res, where.host) }); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = savedName(res.headers.get('content-disposition'), filename);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error('Could not download', { description: 'Check the connection and try again.' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" disabled={busy} onClick={() => void download()} data-testid={`remote-download-${where.diskId}`}
            className={OUTLINE} style={OUTLINE_STYLE}>
      {busy ? 'Downloading…' : 'Download'}
    </button>
  );
}

/**
 * A remote disk's actions (spec §4.5): Mount in DF0:/DF1: (the drive picker of mount-action.tsx, posting to the remote
 * route), Send to Amiga, Download. Nothing that edits: no rename, delete, file operations or write protection.
 */
export function RemoteDiskActions({ where, choices, send, filename, label }: {
  where: Where;
  /** mountChoices for this disk, its id the hidden row's (so a drive holding it reads as this disk). */
  choices: MountChoice[];
  /** The boards that take files; null = no Send button. */
  send: SendContext | null;
  /** The download's fallback name. */
  filename: string;
  /** What a send toast calls it: "Lemmings, disk 1". */
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid={`remote-disk-actions-${where.diskId}`}>
      <RemoteDownload where={where} filename={filename} />
      {send && send.targets.length > 0 && <RemoteSend where={where} ctx={send} label={label} />}
      <MountAction diskId={where.diskId} choices={choices} remote={where} />
    </div>
  );
}
