import { shareJson } from '@/lib/share/api';
import { SHARE_PROTOCOL } from '@/lib/share/tokens';
import type { SharePing } from '@/lib/share/types';

export const dynamic = 'force-dynamic';

/** Unauthenticated: is a WebFloppy share API here, and which protocol does it speak. */
export async function GET() {
  const body: SharePing = { ok: true, protocol: SHARE_PROTOCOL };
  return shareJson(body);
}
