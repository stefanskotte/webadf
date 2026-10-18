import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireOrg } from '@/lib/session';
import {
  decodeLayout, ELEMENT_NAMES, encodeLayout, HEAD_ELEMENT_FIRMWARE, layoutMinFirmware, NFC_ELEMENT_FIRMWARE,
  ROTATION_FIRMWARE, STATUS_ICON_FIRMWARE, type LayoutJson,
} from '@/lib/display-layout';
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
// The panel turned 180 degrees (firmware 1.17.0); absent = 0.
const rotation = z.union([z.literal(0), z.literal(180)]).optional();
const body = z.union([
  z.object({ reset: z.literal(true), panel: z.enum(['128x32', '128x64']), rotation }),
  z.object({ panel: z.enum(['128x32', '128x64']), rotation, elements: z.array(element).max(16) }),
]);

/** Why a 1.17.0+ layout was refused for an older board: the feature it uses, by name. */
function tooOldReason(l: LayoutJson | null, min: string | null): string {
  if (l?.rotation === 180) return `Turning the display needs firmware ${ROTATION_FIRMWARE} or newer`;
  if (l?.elements.some((e) => e.id === 'head')) return `The head position needs firmware ${HEAD_ELEMENT_FIRMWARE} or newer`;
  if (min === STATUS_ICON_FIRMWARE) return `The status icon needs firmware ${STATUS_ICON_FIRMWARE} or newer`;
  if (min === NFC_ELEMENT_FIRMWARE) return `The NFC icon needs firmware ${NFC_ELEMENT_FIRMWARE} or newer`;
  return 'Needs firmware 1.7.1 or newer';
}

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

  // The layout to store: the one sent, or for a reset the panel's built-in
  // default -- null, unless the reset keeps a 180-degree turn, which lives in
  // the blob (a rotation record), so the default's elements are stored with it.
  let layout: LayoutJson | null = null;
  if (!('reset' in parsed.data)) {
    layout = parsed.data;
  } else if (parsed.data.rotation === 180) {
    const panel = parsed.data.panel;
    layout = { ...decodeLayout((await getWasm()).defaultBlob(panel === '128x64' ? 1 : 0)), rotation: 180 };
  }
  // The 'nfc' element (1.10.0), the status icon (1.15.0), the 'head' element
  // and a rotation (1.17.0), shown OR hidden, make older firmware refuse the
  // whole layout (or, from 1.10.0, ignore what it does not know), so a layout
  // that uses one is stored only for a board reporting that version or newer.
  // The editor never offers them to an older board; this is the server's half
  // of that rule.
  const minFirmware = layout ? layoutMinFirmware(layout) : null;
  let blob: Uint8Array | null = null;
  if (layout) {
    blob = encodeLayout(layout);
    const why = (await getWasm()).validate(blob);
    if (why) return Response.json({ error: 'invalid_layout', reason: why }, { status: 400 });
  }
  // not_found covers an unknown device and another org's -- deliberately
  // indistinguishable, like every org-scoped device route.
  const r = minFirmware
    ? await saveDisplay(orgId, id, parsed.data.panel, blob, minFirmware)
    : await saveDisplay(orgId, id, parsed.data.panel, blob);
  if (r === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 });
  if (r === 'firmware_too_old') {
    return Response.json({ error: 'firmware_too_old', reason: tooOldReason(layout, minFirmware) }, { status: 409 });
  }
  return Response.json({ version: r.version });
}
