// What the mount picker (src/components/games/mount-action.tsx) sends, and what it says when refused. Pure and
// CLIENT-SAFE, so the request choice -- local device route or the remote library route -- is unit tested.
import type { MountChoice } from '@/lib/mount-choice';
import { remoteErrorText } from '@/lib/remote/copy';

export type Drive = 'df0' | 'df1';

/**
 * A remote library's disk (library sharing spec §4.2): mounting it goes through this server's remote route, which asks
 * the owner again and holds the bytes as a hidden disk before the ordinary mount. Ejects and a Cancel's re-ask name
 * drives and local disks, so they keep the device routes.
 */
export type RemoteMount = { libraryId: string; titleId: string; diskId: string; host: string };

const JSON_HEADERS = { 'content-type': 'application/json' };

export type MountRequest = { url: string; init: RequestInit; ejecting: boolean; df1Eject: boolean; viaRemote: boolean };

/**
 * Both verbs, one request path. Mount names a disk; eject names none, and means "hold nothing" -- so calling it off a
 * pending fetch also drops whatever the drive still has. A Cancel on a board that still holds a confirmed disk asks for
 * that disk again (mount-choice.ts revertDiskId); only a real eject empties the drive.
 *
 * DF1 (spec 2026-10-14 §3.3): the disk already in DF1 is taken out of DF1 ({"drive":"df1"} to /eject); any other disk
 * goes into DF1 ({diskId, drive:"df1"} to /mount). DF0 is exactly as before. With `remote`, mounting THIS disk (DF0 or
 * DF1) posts {titleId, deviceId, drive} to /api/remote/<library>/disks/<disk>/mount instead.
 */
export function mountRequest(
  choice: Pick<MountChoice, 'id' | 'action' | 'revertDiskId' | 'df1'>, diskId: string, drive: Drive = 'df0', remote?: RemoteMount,
): MountRequest {
  const df1Eject = drive === 'df1' && choice.df1?.isThisDisk === true;
  const ejecting = drive === 'df1' ? df1Eject : choice.action === 'eject';
  const mountId = drive === 'df1' ? (df1Eject ? null : diskId) : ejecting ? choice.revertDiskId : diskId;
  if (remote && mountId === diskId) {
    return {
      url: `/api/remote/${encodeURIComponent(remote.libraryId)}/disks/${encodeURIComponent(remote.diskId)}/mount`,
      init: { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ titleId: remote.titleId, deviceId: choice.id, drive }) },
      ejecting, df1Eject, viaRemote: true,
    };
  }
  const init: RequestInit = mountId
    ? { method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify(drive === 'df1' ? { diskId: mountId, drive } : { diskId: mountId }) }
    : drive === 'df1'
      ? { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ drive }) }
      : { method: 'POST' };
  return { url: `/api/devices/${choice.id}/${mountId ? 'mount' : 'eject'}`, init, ejecting, df1Eject, viaRemote: false };
}

/**
 * A refusal's sentence. One the person can act on carries its own (`reason`: a long-track HFE on old firmware, DF1's
 * rules); a remote refusal carries a code (ended, unreachable, not_shared...) worded by remoteErrorText; anything else
 * falls back to the status.
 */
export function mountFailureText(body: unknown, status: number, req: Pick<MountRequest, 'viaRemote'>, host?: string): string {
  const b = body && typeof body === 'object' ? body as { reason?: unknown; error?: unknown; host?: unknown } : null;
  if (typeof b?.reason === 'string') return b.reason;
  if (req.viaRemote && typeof b?.error === 'string') return remoteErrorText(b.error, typeof b.host === 'string' ? b.host : host ?? null);
  return `The server answered ${status}.`;
}
