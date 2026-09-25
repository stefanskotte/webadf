'use client';

import { toast } from 'sonner';

/**
 * The two device-facing writes, with the error handling their buttons grew,
 * shared so that every control that asks for them -- EjectButton and
 * WriteProtectToggle, and the header's drive chips -- says the same thing
 * when it fails. Each returns whether the server accepted the request; the
 * caller decides how to refresh, because a button in a card and an item in a
 * menu that has already closed want different things afterwards.
 */

/** POST /api/devices/[id]/eject. A desired-state write: the board acts on its next poll. */
export async function requestEject(deviceId: string): Promise<boolean> {
  // fetch itself rejects on a network failure (offline, DNS, aborted) --
  // before there is any Response to check `.ok` on. Without this try/catch
  // that rejection is unhandled and the control just silently snaps back
  // with nothing on screen.
  let res: Response;
  try {
    res = await fetch(`/api/devices/${deviceId}/eject`, { method: 'POST' });
  } catch {
    toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    return false;
  }
  if (!res.ok) {
    toast.error('Could not eject', { description: `The server answered ${res.status}.` });
    return false;
  }
  // The eject is recorded. The device still has to act on it, which is why
  // every view of it now reads as in flight ("Ejecting…") rather than empty
  // -- desired has changed, actual has not yet.
  toast.success('Eject requested');
  return true;
}

/**
 * PATCH /api/disks/[id] { writeProtected }. The flag belongs to the DISK, not
 * to any one device: it changes on the disk's page and on every board
 * holding it (a board learns it on its next poll).
 */
export async function requestWriteProtect(diskId: string, writeProtected: boolean): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`/api/disks/${diskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ writeProtected }),
    });
  } catch {
    toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    return false;
  }
  if (!res.ok) {
    toast.error('Could not change write protection', { description: `The server answered ${res.status}.` });
    return false;
  }
  return true;
}
