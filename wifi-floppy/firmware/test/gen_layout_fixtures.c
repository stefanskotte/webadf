// Host helper (not a test; run.sh only builds test_*.c): writes the golden
// layout blobs under fixtures/layouts/. Build and run from test/:
//   cc -std=c11 -o .build/gen_layout_fixtures gen_layout_fixtures.c ../src/display_layout.c
//   .build/gen_layout_fixtures
#include "../src/display_layout.h"
#include <stdio.h>
#include <string.h>

static void put(const char *name, const uint8_t *b, int n) {
    char p[96]; snprintf(p, sizeof p, "fixtures/layouts/%s.bin", name);
    FILE *f = fopen(p, "wb");
    if (!f || n < 0 || fwrite(b, 1, (size_t)n, f) != (size_t)n) { fprintf(stderr, "write %s failed\n", p); if (f) fclose(f); return; }
    fclose(f);
}

static void put_layout(const char *name, const layout_t *l) {
    uint8_t b[LAYOUT_BLOB_MAX]; put(name, b, layout_encode(l, b, sizeof b));
}

int main(void) {
    layout_t l;
    put_layout("default32", layout_default(PANEL_128x32));
    put_layout("default64", layout_default(PANEL_128x64));

    l = *layout_default(PANEL_128x64);
    for (int i = 0; i < l.n; i++) if (l.el[i].id == EL_TITLE) { l.el[i].x = 0; l.el[i].y = 16; l.el[i].scale = 1; l.el[i].opt = 1; l.el[i].w = 128; }
    put_layout("custom64", &l);

    l = *layout_default(PANEL_128x32);
    for (int i = 0; i < l.n; i++) if (l.el[i].id == EL_TITLE) l.el[i].y = 20;
    put_layout("bad_bounds", &l);

    l = *layout_default(PANEL_128x32);
    l.el[1].id = l.el[0].id;
    put_layout("bad_dup", &l);

    uint8_t b[LAYOUT_BLOB_MAX];
    int n = layout_encode(layout_default(PANEL_128x32), b, sizeof b);
    b[4 + 6] = 1;
    put("bad_reserved", b, n);
    return 0;
}
