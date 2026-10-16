/* An in-memory rx_fs for the core's tests: up to 32 entries, 64 KB each. */
#include <string.h>
#include "rx_proto.h"

#define FF_MAX 32
typedef struct { char name[RX_PATH_MAX + sizeof RX_TMP_NAME]; int is_dir; unsigned char data[65536]; unsigned long len;
                 unsigned long prot; char comment[RX_COMMENT_MAX + 1]; } ff_entry;
typedef struct {
    ff_entry e[FF_MAX]; int n;
    int folder_present; unsigned long free; int fail_write_after; /* -1 never */ long written;
    int open_idx; int make_dir_calls; int fail_make_dir;
} fakefs;

static int ff_find(fakefs *f, const char *rel) {
    for (int i = 0; i < f->n; i++) if (strcmp(f->e[i].name, rel) == 0) return i;
    return -1;
}
static int ff_add(fakefs *f, const char *rel, int is_dir) {
    int i = ff_find(f, rel);
    if (i >= 0) return i;
    i = f->n++;
    memset(&f->e[i], 0, sizeof f->e[i]);
    strcpy(f->e[i].name, rel); f->e[i].is_dir = is_dir;
    return i;
}
static int ff_folder_ok(void *c) { return ((fakefs *)c)->folder_present; }
static unsigned long ff_free(void *c) { return ((fakefs *)c)->free; }
static int ff_exists(void *c, const char *rel) { return ff_find(c, rel) >= 0; }
static int ff_make_dir(void *c, const char *rel) {
    fakefs *f = c; f->make_dir_calls++;
    if (f->fail_make_dir) return -1;
    ff_add(f, rel, 1); return 0;
}
static int ff_open_w(void *c, const char *rel) {
    fakefs *f = c; int i = ff_add(f, rel, 0); f->e[i].len = 0; f->open_idx = i; f->written = 0; return 0;
}
static int ff_write(void *c, const unsigned char *b, unsigned long n) {
    fakefs *f = c;
    if (f->fail_write_after >= 0 && f->written + (long)n > f->fail_write_after) return -1;
    ff_entry *e = &f->e[f->open_idx];
    memcpy(e->data + e->len, b, n); e->len += n; f->written += (long)n; return 0;
}
static int ff_close_w(void *c) { ((fakefs *)c)->open_idx = -1; return 0; }
static int ff_rename(void *c, const char *from, const char *to) {
    fakefs *f = c; int i = ff_find(f, from);
    if (i < 0 || ff_find(f, to) >= 0) return -1;
    strcpy(f->e[i].name, to); return 0;
}
static int ff_remove(void *c, const char *rel) {
    fakefs *f = c; int i = ff_find(f, rel);
    if (i < 0) return -1;
    f->e[i] = f->e[--f->n]; return 0;
}
static int ff_set_meta(void *c, const char *rel, unsigned long prot, const char *comment) {
    fakefs *f = c; int i = ff_find(f, rel);
    if (i < 0) return -1;
    f->e[i].prot = prot; strcpy(f->e[i].comment, comment); return 0;
}
static void ff_init(fakefs *f, rx_fs *fs) {
    memset(f, 0, sizeof *f);
    f->folder_present = 1; f->free = 0xFFFFFFFFUL; f->fail_write_after = -1; f->open_idx = -1;
    fs->ctx = f; fs->folder_ok = ff_folder_ok; fs->free_bytes = ff_free; fs->exists = ff_exists;
    fs->make_dir = ff_make_dir; fs->open_w = ff_open_w; fs->write = ff_write; fs->close_w = ff_close_w;
    fs->rename = ff_rename; fs->remove = ff_remove; fs->set_meta = ff_set_meta;
}
