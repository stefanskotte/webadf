#include "display_layout.h"
#include <stdio.h>
#include <string.h>

// Spec 2026-10-04-oled-layouts §4-§5. Pure: no SDK. Compiled into the
// firmware AND the WebAssembly module, so the editor can never save what the
// board would refuse.

int panel_height(panel_t p) { return p == PANEL_128x64 ? 64 : 32; }

void layout_el_size(const layout_el_t *e, int *w, int *h) {
    int bw = 0, bh = LAYOUT_LINE_H;
    switch (e->id) {
        case EL_STATUS:   bw = STATUS_MAX_CHARS * LAYOUT_ADVANCE; break;
        case EL_WIFI:     bw = 11; break;
        case EL_WRITE:    bw = 8;  break;
        case EL_LEMMING:  bw = 8;  break;
        case EL_TITLE:    bw = e->w; bh = LAYOUT_LINE_H * (e->opt ? e->opt : 1); break;
        case EL_DETAIL:   bw = e->w; break;
        case EL_TRACK:    bw = TRACK_MAX_CHARS * LAYOUT_ADVANCE; break;
        case EL_DOWNLOAD: bw = (e->w ? e->w + 2 : 0) + PCT_MAX_CHARS * LAYOUT_ADVANCE; break;
        default: break;
    }
    const int s = e->scale == 2 ? 2 : 1;
    *w = bw * s; *h = bh * s;
}

static bool no(char *why, size_t n, const char *msg) {
    if (n) snprintf(why, n, "%s", msg);
    return false;
}

bool layout_decode(const uint8_t *b, size_t len, layout_t *out, char *why, size_t n) {
    if (n) why[0] = '\0';
    if (len < 4)                  return no(why, n, "length: shorter than the header");
    if (b[0] != LAYOUT_FORMAT)    return no(why, n, "format: unknown");
    if (b[1] > PANEL_128x64)      return no(why, n, "panel: unknown");
    if (b[3] != 0)                return no(why, n, "reserved: header byte 3 must be 0");
    if (b[2] > LAYOUT_MAX_ELEMENTS) return no(why, n, "length: more than 16 elements");
    if (len != 4u + 8u * b[2])    return no(why, n, "length: does not match the element count");

    layout_t l; memset(&l, 0, sizeof l);
    l.panel = (panel_t)b[1]; l.n = b[2];
    const int W = 128, H = panel_height(l.panel);
    bool seen[9] = { false };
    for (int i = 0; i < l.n; i++) {
        const uint8_t *r = b + 4 + 8 * i;
        if (r[0] < EL_STATUS || r[0] > EL_LEMMING) return no(why, n, "element id: unknown");
        if (seen[r[0]])                             return no(why, n, "element id: listed twice");
        seen[r[0]] = true;
        if (r[1] & ~0x03u)                          return no(why, n, "flags: unknown bits");
        if (r[6] != 0 || r[7] != 0)                 return no(why, n, "reserved: record bytes 6-7 must be 0");
        layout_el_t e = { r[0], (uint8_t)(r[1] & 1u), (uint8_t)((r[1] & 2u) ? 2 : 1), r[2], r[3], r[4], r[5] };
        switch (e.id) {
            case EL_TITLE:
                if (e.w < 12)                return no(why, n, "title: width must be at least 12");
                if (e.opt < 1 || e.opt > 2)  return no(why, n, "title: lines must be 1 or 2");
                break;
            case EL_DETAIL:
                if (e.w < 12)                return no(why, n, "detail: width must be at least 12");
                if (e.opt != 0)              return no(why, n, "detail: opt must be 0");
                break;
            case EL_DOWNLOAD:
                if (e.w != 0 && e.w < 8)     return no(why, n, "download: bar must be 0 or at least 8 wide");
                if (e.opt != 0)              return no(why, n, "download: opt must be 0");
                break;
            default:
                if (e.w != 0)                return no(why, n, "w must be 0 for this element");
                if (e.opt != 0)              return no(why, n, "opt must be 0 for this element");
                break;
        }
        int ew, eh; layout_el_size(&e, &ew, &eh);
        if (e.x + ew > W || e.y + eh > H)  return no(why, n, "outside the panel");
        l.el[i] = e;
    }
    *out = l;
    return true;
}

int layout_encode(const layout_t *l, uint8_t *b, size_t cap) {
    const size_t need = 4u + 8u * l->n;
    if (l->n > LAYOUT_MAX_ELEMENTS || need > cap) return -1;
    b[0] = LAYOUT_FORMAT; b[1] = (uint8_t)l->panel; b[2] = l->n; b[3] = 0;
    for (int i = 0; i < l->n; i++) {
        const layout_el_t *e = &l->el[i];
        uint8_t *r = b + 4 + 8 * i;
        r[0] = e->id;
        r[1] = (uint8_t)((e->visible ? 1u : 0u) | (e->scale == 2 ? 2u : 0u));
        r[2] = e->x; r[3] = e->y; r[4] = e->w; r[5] = e->opt; r[6] = 0; r[7] = 0;
    }
    return (int)need;
}

// Drawing order matters (spec §4: list order). Track and download come BEFORE
// detail so the renderer's clip rule (Task 3) sees them first -- the same order
// 1.6.5 drew them in.
static const layout_t DEFAULT_32 = {
    PANEL_128x32, 8, {
        { EL_WIFI,     1, 1,   0,  0,   0, 0 },
        { EL_LEMMING,  1, 1, 120,  0,   0, 0 },
        { EL_WRITE,    1, 1, 110,  0,   0, 0 },
        { EL_STATUS,   1, 1,  14,  0,   0, 0 },
        { EL_TITLE,    1, 1,   0,  8, 128, 2 },
        { EL_TRACK,    1, 1,  98, 24,   0, 0 },
        { EL_DOWNLOAD, 1, 1, 104, 24,   0, 0 },
        { EL_DETAIL,   1, 1,   0, 24, 128, 0 },
    }
};

// 128x64 (spec §5): the status row as today, the title at 2x on one line
// (64 x 2 = 128 px wide), the detail line, the counter at 2x bottom-right,
// and download as a bar.
static const layout_t DEFAULT_64 = {
    PANEL_128x64, 8, {
        { EL_WIFI,     1, 1,   0,  0,   0, 0 },
        { EL_LEMMING,  1, 1, 120,  0,   0, 0 },
        { EL_WRITE,    1, 1, 110,  0,   0, 0 },
        { EL_STATUS,   1, 1,  14,  0,   0, 0 },
        { EL_TITLE,    1, 2,   0, 12,  64, 1 },
        { EL_TRACK,    1, 2,  68, 46,   0, 0 },
        { EL_DOWNLOAD, 1, 1,   0, 56,  96, 0 },
        { EL_DETAIL,   1, 1,   0, 32, 128, 0 },
    }
};

const layout_t *layout_default(panel_t p) { return p == PANEL_128x64 ? &DEFAULT_64 : &DEFAULT_32; }
