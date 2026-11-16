import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { requestWifi } from '@/lib/wifi-networks-store';
import { WIFI_HEX_RE } from '@/lib/wifi-networks';

// Board settings > Wi-Fi networks (src/lib/wifi-networks.ts). Each press is a request the board picks up from its
// next poll: open its setup page (ten minutes; again = ten more), close it, remove a saved network, or cancel a
// request the board has not handled yet. Names travel as the board's hex; passwords never come here.
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open') }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('remove'), ssid: z.string().regex(WIFI_HEX_RE) }),
]);

const REASONS = {
  firmware_too_old: 'This board’s firmware does not manage its Wi-Fi networks from here. Update the firmware.',
  not_saved: 'The board does not have that network saved.',
  in_use: 'The board is on that network now, so it stays.',
  only_one: 'It is the only saved network. Add another first.',
  nothing_to_cancel: 'The board has already handled the request.',
} as const;

// CSRF: as every device route here, Better Auth's SameSite=Lax session cookie (see ../mount/route.ts).
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  const r = await requestWifi(orgId, id, parsed.data.action, parsed.data.action === 'remove' ? parsed.data.ssid : null);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (typeof r === 'string') return Response.json({ error: r, reason: REASONS[r] }, { status: 409 });
  return Response.json({ seq: r.seq });
}
