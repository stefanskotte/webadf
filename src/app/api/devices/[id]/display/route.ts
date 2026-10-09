import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireOrg } from '@/lib/session';
import { ELEMENT_NAMES, encodeLayout, NFC_ELEMENT_FIRMWARE } from '@/lib/display-layout';
import { loadDisplayWasm, type DisplayWasm } from '@/lib/display-wasm';
import { saveDisplay } from '@/lib/display-store';

// public/display.wasm is the board's own validator (spec §5: the web app
// encodes and never validates on its own). Read from disk on the server; the
// deployed function carries it because next.config.ts names it in
// outputFileTracingIncludes for this route -- public/ is not in a function
// bundle otherwise. Loaded once per instance; a failed load is not cached.
let wasm: Promise<DisplayWasm> | null = null;
const getWasm = () => (wasm ??= readFile(path.join(process.cwd(), 'public', 'display.wasm'))
  .then((b) => loadDisplayWasm(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer))
  .catch((e: unknown) => { wasm = null; throw e; }));

const element = z.object({
  id: z.enum(ELEMENT_NAMES),
  visible: z.boolean(), scale: z.union([z.literal(1), z.literal(2)]),
  x: z.number().int().min(0).max(255), y: z.number().int().min(0).max(255),
  w: z.number().int().min(0).max(255), opt: z.number().int().min(0).max(255),
});
const body = z.union([
  z.object({ reset: z.literal(true), panel: z.enum(['128x32', '128x64']) }),
  z.object({ panel: z.enum(['128x32', '128x64']), elements: z.array(element).max(16) }),
]);

// CSRF: as for every device route here, this relies on Better Auth's default
// SameSite=Lax session cookie (see ../mount/route.ts).
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  let blob: Uint8Array | null = null;
  // The 'nfc' element, shown OR hidden, makes firmware before 1.10.0 refuse
  // the whole layout, so a layout that lists it is stored only for a board
  // reporting 1.10.0 or newer. The editor never offers it to an older one;
  // this is the server's half of that rule.
  const wantsNfc = !('reset' in parsed.data) && parsed.data.elements.some((e) => e.id === 'nfc');
  if (!('reset' in parsed.data)) {
    blob = encodeLayout(parsed.data);
    const why = (await getWasm()).validate(blob);
    if (why) return Response.json({ error: 'invalid_layout', reason: why }, { status: 400 });
  }
  // not_found covers an unknown device and another org's -- deliberately
  // indistinguishable, like every org-scoped device route.
  const r = wantsNfc
    ? await saveDisplay(orgId, id, parsed.data.panel, blob, NFC_ELEMENT_FIRMWARE)
    : await saveDisplay(orgId, id, parsed.data.panel, blob);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (r === 'firmware_too_old') {
    const reason = wantsNfc
      ? `The NFC icon needs firmware ${NFC_ELEMENT_FIRMWARE} or newer`
      : 'Needs firmware 1.7.1 or newer';
    return Response.json({ error: 'firmware_too_old', reason }, { status: 409 });
  }
  return Response.json({ version: r.version });
}
