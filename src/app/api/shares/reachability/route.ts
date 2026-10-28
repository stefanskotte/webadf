import { requireOrg } from '@/lib/session';
import { checkReachability } from '@/lib/share/instance';

export const maxDuration = 60;

/** Settings > Sharing's reachability line (spec §3.3): this server pinging its own public address. */
export async function GET() {
  await requireOrg();
  let result: { ok: boolean; origin: string; detail?: string };
  try {
    result = await checkReachability();
  } catch (e) {
    // publicOrigin() throws when BETTER_AUTH_URL is unset or not a URL.
    result = { ok: false, origin: '', detail: e instanceof Error ? e.message : 'unknown error' };
  }
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
}
