import { requireSuperAdmin } from '@/lib/superadmin';
import { sweep } from '@/lib/tosec-sweep';

export const maxDuration = 300;

/** Run one sweep batch on demand. Same work the cron does, different door. */
export async function POST() {
  await requireSuperAdmin();
  return Response.json(await sweep());
}
