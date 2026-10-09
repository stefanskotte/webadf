// The board's own renderer and validator, for the web app (spec §7). Built by
// scripts/display-wasm.sh; nothing here is used by the firmware.
#include "display.h"
#include "display_layout.h"
#include <stddef.h>
#include <string.h>

static uint8_t  g_fb[DISP_FB_MAX];
static uint8_t  g_blob[LAYOUT_BLOB_MAX];
static char     g_why[80];
static display_state_t g_state;
static uint8_t  g_out[LAYOUT_BLOB_MAX];

__attribute__((export_name("fb_ptr")))    uint8_t *fb_ptr(void)    { return g_fb; }
__attribute__((export_name("blob_ptr")))  uint8_t *blob_ptr(void)  { return g_blob; }
__attribute__((export_name("why_ptr")))   char    *why_ptr(void)   { return g_why; }
__attribute__((export_name("state_ptr"))) display_state_t *state_ptr(void) { return &g_state; }
__attribute__((export_name("out_ptr")))   uint8_t *out_ptr(void)   { return g_out; }
__attribute__((export_name("state_size"))) int state_size(void) { return (int)sizeof g_state; }

/** Byte offset of display_state_t field `i` (0 status, 1 bars, 2 title, 3 detail,
 *  4 show_track, 5 cyl, 6 max_cyl, 7 pct, 8 tick, 9 writable, 10 sync, 11 nfc); -1 unknown.
 *  The loader checks its own table against these, so a layout drift fails loudly. */
__attribute__((export_name("state_off"))) int state_off(int i) {
    switch (i) {
    case 0:  return (int)offsetof(display_state_t, status);
    case 1:  return (int)offsetof(display_state_t, bars);
    case 2:  return (int)offsetof(display_state_t, title);
    case 3:  return (int)offsetof(display_state_t, detail);
    case 4:  return (int)offsetof(display_state_t, show_track);
    case 5:  return (int)offsetof(display_state_t, cyl);
    case 6:  return (int)offsetof(display_state_t, max_cyl);
    case 7:  return (int)offsetof(display_state_t, pct);
    case 8:  return (int)offsetof(display_state_t, tick);
    case 9:  return (int)offsetof(display_state_t, writable);
    case 10: return (int)offsetof(display_state_t, sync);
    case 11: return (int)offsetof(display_state_t, nfc);
    default: return -1;
    }
}

/** 1 = valid, 0 = rejected (reason at why_ptr). */
__attribute__((export_name("validate"))) int validate(int len) {
    layout_t l; return layout_decode(g_blob, (size_t)len, &l, g_why, sizeof g_why) ? 1 : 0;
}

/** Render g_state with the blob (len 0 = the panel's default) into g_fb. 1 ok, 0 invalid blob. */
__attribute__((export_name("render"))) int render(int panel, int len) {
    layout_t l;
    const layout_t *use = layout_default((panel_t)panel);
    if (len > 0) { if (!layout_decode(g_blob, (size_t)len, &l, g_why, sizeof g_why)) return 0; use = &l; }
    display_render(&g_state, display_layout_for(&g_state, use), g_fb);
    return 1;
}

/** The encoded default for `panel` into g_out; returns its length. */
__attribute__((export_name("default_blob"))) int default_blob(int panel) {
    return layout_encode(layout_default((panel_t)panel), g_out, sizeof g_out);
}
