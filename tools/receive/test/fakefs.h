/* An in-memory rx_fs for the core's tests: up to 400 entries, 64 KB each. */
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include "rx_proto.h"

#define FF_MAX 400
/* AmigaDOS error numbers the fake gives (dos/dos.h) */
#define FF_IN_USE 202
#define FF_EXISTS 203
#define FF_WRITE_PROTECTED_DISK 214
#define FF_NOT_EMPTY 216
#define FF_DISK_FULL 221
#define FF_DELETE_PROTECTED 222
typedef struct { char name[RX_PATH_MAX + sizeof RX_TMP_NAME]; int is_dir; unsigned char data[65536]; unsigned long len;
                 unsigned long prot; char comment[RX_COMMENT_MAX + 1]; int busy;
                 char link_to[64]; /* a soft or hard link: paths through it resolve there, as AmigaDOS does */ } ff_entry;
typedef struct {
    int n;
    int folder_present; unsigned long free; int fail_write_after; /* -1 never */ long written;
    int open_idx; int make_dir_calls; int fail_make_dir;
    /* protocol 2: the file being read (an entry named by its local path) */
    int read_idx; unsigned long read_pos, bytes_read; long fail_read_at; /* -1 never */
    int opens_r, closes_r; unsigned long days, mins, ticks;
    /* protocol 3: the volumes, the drawer being listed, and a made-up drawer of synth_n files f0000.. (FF_MAX is far
       below the 1000-entry cut) */
    rx_vol vols[RX_VOLS_MAX]; int nvols, vols_fail;
    char dir_path[RX_LOCAL_MAX + 1]; int dir_pos, dir_given, dir_open, dir_opens, dir_closes; long dir_fail_after; /* -1 never */
    char synth[RX_LOCAL_MAX + 1]; int synth_n;
    long stat_err; unsigned long stat_size; int stat_calls;   /* stat_err: every stat fails so; stat_size: reported instead */
    /* protocol 4: the DOS error of the last failed hook; a write-protected volume ("Floppy:"); free bytes on any volume;
       the error a failing write gives; dir_open fails with dir_err from the dir_err_at-th open on (0 never); a count of
       the write hooks called */
    long last_err; char wprot[32]; unsigned long vol_free; long write_err; long dir_err; int dir_err_at; int writes;
    char fail_rename_to[64]; int fail_renames;   /* a rename onto that name (or, fail_renames, every rename) fails 203 */
    /* Transfer 2.6: every w_rename fails with rename_err (0 never); after a w_rename that worked, plant is put (its drawers
       made: something saved by the old path meanwhile); the w_renames called, and the last one's paths */
    long rename_err; char plant[64]; int renames; char last_from[RX_LOCAL_MAX + 1], last_to[RX_LOCAL_MAX + 1];
    ff_entry e[FF_MAX];   /* last: ff_init clears only what is above it */
} fakefs;
static int ff_wprot(fakefs *f, const char *p) { return f->wprot[0] && strncmp(p, f->wprot, strlen(f->wprot)) == 0; }
static int ff_fail(fakefs *f, long err) { f->last_err = err; return -1; }

static int ff_find(fakefs *f, const char *rel) {
    for (int i = 0; i < f->n; i++) if (strcmp(f->e[i].name, rel) == 0) return i;
    for (int i = 0; i < f->n; i++) {   /* a path through a link reaches its target */
        size_t k = strlen(f->e[i].name);
        if (f->e[i].link_to[0] && strncmp(rel, f->e[i].name, k) == 0 && rel[k] == '/') {
            char t[RX_PATH_MAX + 80];
            snprintf(t, sizeof t, "%s%s", f->e[i].link_to, rel + k);
            return ff_find(f, t);
        }
    }
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
    fakefs *f = c; f->make_dir_calls++; f->writes++;
    if (ff_wprot(f, rel)) return ff_fail(f, FF_WRITE_PROTECTED_DISK);
    if (f->fail_make_dir) return -1;
    ff_add(f, rel, 1); return 0;
}
static int ff_open_w(void *c, const char *rel) {
    fakefs *f = c; int i;
    f->writes++;
    if (ff_wprot(f, rel)) return ff_fail(f, FF_WRITE_PROTECTED_DISK);
    i = ff_add(f, rel, 0); f->e[i].len = 0; f->open_idx = i; f->written = 0; return 0;
}
static int ff_write(void *c, const unsigned char *b, unsigned long n) {
    fakefs *f = c;
    if (f->fail_write_after >= 0 && f->written + (long)n > f->fail_write_after) return ff_fail(f, f->write_err);
    ff_entry *e = &f->e[f->open_idx];
    memcpy(e->data + e->len, b, n); e->len += n; f->written += (long)n; return 0;
}
static int ff_close_w(void *c) { ((fakefs *)c)->open_idx = -1; return 0; }
static int ff_rename(void *c, const char *from, const char *to) {
    fakefs *f = c; int i = ff_find(f, from);
    f->writes++;
    if (ff_wprot(f, from)) return ff_fail(f, FF_WRITE_PROTECTED_DISK);
    if (i < 0) return ff_fail(f, RX_DOS_NOT_FOUND);
    if (ff_find(f, to) >= 0 || f->fail_renames || (f->fail_rename_to[0] && strcmp(to, f->fail_rename_to) == 0)) return ff_fail(f, FF_EXISTS);
    {   /* a drawer takes what is inside it along */
        size_t n = strlen(from); int k;
        for (k = 0; k < f->n; k++) if (strncmp(f->e[k].name, from, n) == 0 && f->e[k].name[n] == '/') {
            char t[sizeof f->e[k].name];
            snprintf(t, sizeof t, "%s%s", to, f->e[k].name + n); strcpy(f->e[k].name, t);
        }
    }
    strcpy(f->e[i].name, to); return 0;
}
static int ff_has_children(fakefs *f, const char *dir) {
    size_t n = strlen(dir); int k;
    for (k = 0; k < f->n; k++)
        if (strncmp(f->e[k].name, dir, n) == 0 && f->e[k].name[n] && (dir[n - 1] == ':' || f->e[k].name[n] == '/')) return 1;
    return 0;
}
static int ff_remove(void *c, const char *rel) {
    fakefs *f = c; int i = ff_find(f, rel);
    f->writes++;
    if (ff_wprot(f, rel)) return ff_fail(f, FF_WRITE_PROTECTED_DISK);
    if (i < 0) return ff_fail(f, RX_DOS_NOT_FOUND);
    if (f->e[i].busy) return ff_fail(f, FF_IN_USE);
    if (f->e[i].prot & 1UL) return ff_fail(f, FF_DELETE_PROTECTED);   /* FIBF_DELETE set: the d-bit is off */
    if (f->e[i].is_dir && ff_has_children(f, rel)) return ff_fail(f, FF_NOT_EMPTY);
    f->e[i] = f->e[--f->n]; return 0;
}
static int ff_set_meta(void *c, const char *rel, unsigned long prot, const char *comment) {
    fakefs *f = c; int i = ff_find(f, rel);
    f->writes++;
    if (ff_wprot(f, rel)) return ff_fail(f, FF_WRITE_PROTECTED_DISK);
    if (i < 0) return -1;
    f->e[i].prot = prot; strcpy(f->e[i].comment, comment); return 0;
}
static int ff_put(fakefs *f, const char *name, const void *data, unsigned long len, unsigned long prot, const char *comment) {
    int i = ff_add(f, name, 0);
    memcpy(f->e[i].data, data, len); f->e[i].len = len; f->e[i].prot = prot;
    snprintf(f->e[i].comment, sizeof f->e[i].comment, "%s", comment);
    return i;
}
static int ff_is_dir(void *c, const char *local) { int i = ff_find(c, local); return i < 0 ? -1 : ((fakefs *)c)->e[i].is_dir; }
/* The children of a drawer: "DH0:D/x" under "DH0:D", and "RAM:x" under the volume root "RAM:". */
static int ff_list(void *c, const char *local, rx_list_fn each, void *u) {
    fakefs *f = c; size_t n = strlen(local); int i = ff_find(f, local);
    int root = n > 0 && local[n - 1] == ':';
    if (i < 0 || !f->e[i].is_dir) return -1;
    for (int k = 0; k < f->n; k++) {
        const char *nm = f->e[k].name;
        if (strncmp(nm, local, n) != 0 || !nm[n]) continue;
        const char *rest = root ? nm + n : (nm[n] == '/' ? nm + n + 1 : NULL);
        if (rest && rest[0] && !strchr(rest, '/')) each(u, rest, f->e[k].is_dir);
    }
    return 0;
}
static int ff_open_r(void *c, const char *local, rx_finfo *info) {
    fakefs *f = c; int i = ff_find(f, local);
    if (i < 0 || f->e[i].is_dir) return -1;
    f->read_idx = i; f->read_pos = 0; f->opens_r++;
    info->size = f->e[i].len; info->prot = f->e[i].prot; snprintf(info->comment, sizeof info->comment, "%s", f->e[i].comment);
    info->days = f->days; info->mins = f->mins; info->ticks = f->ticks;
    return 0;
}
static long ff_read(void *c, unsigned char *b, unsigned long n) {
    fakefs *f = c; ff_entry *e = &f->e[f->read_idx];
    if (f->fail_read_at >= 0 && (long)(f->read_pos + n) > f->fail_read_at) return -1;
    if (n > e->len - f->read_pos) n = e->len - f->read_pos;
    memcpy(b, e->data + f->read_pos, n); f->read_pos += n; f->bytes_read += n;
    return (long)n;
}
static void ff_close_r(void *c) { fakefs *f = c; f->read_idx = -1; f->closes_r++; }
static int ff_vols(void *c, rx_vol *out, int max) {
    fakefs *f = c; int i;
    if (f->vols_fail) return -1;
    for (i = 0; i < f->nvols && i < max; i++) out[i] = f->vols[i];
    return i;
}
/* nm's last part when nm is a child of the drawer dir ("Work:" holds "Work:x"; "Work:D" holds "Work:D/x"), else NULL. */
static const char *ff_child_of(const char *nm, const char *dir) {
    size_t n = strlen(dir); int root = n > 0 && dir[n - 1] == ':'; const char *rest;
    if (strncmp(nm, dir, n) != 0 || !nm[n]) return NULL;
    rest = root ? nm + n : (nm[n] == '/' ? nm + n + 1 : NULL);
    return rest && rest[0] && !strchr(rest, '/') ? rest : NULL;
}
static long ff_dir_open(void *c, const char *path) {
    fakefs *f = c;
    if (f->dir_err_at && f->dir_opens + 1 >= f->dir_err_at) { f->dir_opens++; return f->dir_err; }
    if (!(f->synth_n && strcmp(path, f->synth) == 0)) {
        int i = ff_find(f, path);
        if (i < 0) return RX_DOS_NOT_FOUND;
        if (f->e[i].link_to[0]) { path = f->e[i].link_to; i = ff_find(f, path); if (i < 0) return RX_DOS_NOT_FOUND; }   /* Lock follows */
        if (!f->e[i].is_dir) return RX_DOS_WRONG_TYPE;
    }
    snprintf(f->dir_path, sizeof f->dir_path, "%s", path);
    f->dir_pos = 0; f->dir_given = 0; f->dir_open = 1; f->dir_opens++;
    return 0;
}
static long ff_dir_next(void *c, rx_dent *e) {
    fakefs *f = c;
    if (f->dir_fail_after >= 0 && f->dir_given == f->dir_fail_after) return -RX_DOS_NO_DISK;
    memset(e, 0, sizeof *e);
    if (f->synth_n && strcmp(f->dir_path, f->synth) == 0) {
        if (f->dir_pos >= f->synth_n) return 0;
        sprintf(e->name, "f%04d", f->dir_pos); e->size = (unsigned long)f->dir_pos;
        f->dir_pos++; f->dir_given++;
        return 1;
    }
    while (f->dir_pos < f->n) {
        ff_entry *x = &f->e[f->dir_pos++];
        const char *rest = ff_child_of(x->name, f->dir_path);
        if (!rest) continue;
        snprintf(e->name, sizeof e->name, "%s", rest);
        e->is_dir = x->is_dir; e->is_link = x->link_to[0] != 0; e->size = x->is_dir ? 0 : x->len; e->prot = x->prot;
        snprintf(e->comment, sizeof e->comment, "%s", x->comment);
        e->days = f->days; e->mins = f->mins; e->ticks = f->ticks;
        f->dir_given++;
        return 1;
    }
    return 0;
}
static void ff_dir_close(void *c) { fakefs *f = c; f->dir_open = 0; f->dir_closes++; }
static long ff_stat(void *c, const char *path, rx_finfo *info, int *is_dir) {
    fakefs *f = c; int i;
    f->stat_calls++;
    if (f->stat_err) return f->stat_err;
    i = ff_find(f, path);
    if (i < 0) return RX_DOS_NOT_FOUND;
    if (f->e[i].busy) return FF_IN_USE;   /* as Lock() on a file opened for writing: it exists, but cannot be examined */
    *is_dir = f->e[i].is_dir;
    info->size = f->stat_size ? f->stat_size : f->e[i].len; info->prot = f->e[i].prot;
    info->days = f->days; info->mins = f->mins; info->ticks = f->ticks;
    snprintf(info->comment, sizeof info->comment, "%s", f->e[i].comment);
    return 0;
}
static void ff_fault(void *c, long err, char *text, unsigned cap) { (void)c; snprintf(text, cap, "dos error %ld", err); }
/* protocol 4 */
static long ff_err(void *c) { return ((fakefs *)c)->last_err; }
static unsigned long ff_free_at(void *c, const char *path) { (void)path; return ((fakefs *)c)->vol_free; }
static long ff_rc(fakefs *f, int r) { return r == 0 ? 0 : f->last_err; }
static long ff_w_mkdir(void *c, const char *path) {
    fakefs *f = c; char p[RX_LOCAL_MAX + 1]; char *cut;
    f->writes++;
    if (ff_wprot(f, path)) return FF_WRITE_PROTECTED_DISK;
    if (ff_find(f, path) >= 0) return FF_EXISTS;
    snprintf(p, sizeof p, "%s", path); cut = strrchr(p, '/');
    if (cut) *cut = 0; else if ((cut = strchr(p, ':')) != NULL) cut[1] = 0;
    if (ff_find(f, p) < 0) return RX_DOS_NOT_FOUND;   /* the parent must exist: one level */
    ff_add(f, path, 1); return 0;
}
static long ff_w_rename(void *c, const char *from, const char *to) {
    fakefs *f = c; long r;
    f->renames++; snprintf(f->last_from, sizeof f->last_from, "%s", from); snprintf(f->last_to, sizeof f->last_to, "%s", to);
    if (f->rename_err) { f->writes++; return f->rename_err; }
    r = ff_rc(f, ff_rename(c, from, to));
    if (r == 0 && f->plant[0]) {   /* its drawers, then the file */
        char p[64]; char *q;
        snprintf(p, sizeof p, "%s", f->plant);
        for (q = strchr(p, '/'); q; q = strchr(q + 1, '/')) { *q = 0; ff_add(f, p, 1); *q = '/'; }
        ff_put(f, f->plant, "new", 3, 0, ""); f->plant[0] = 0;
    }
    return r;
}
static long ff_w_delete(void *c, const char *path) { return ff_rc(c, ff_remove(c, path)); }
static long ff_w_protect(void *c, const char *path, unsigned long prot) {
    fakefs *f = c; int i = ff_find(f, path);
    f->writes++;
    if (ff_wprot(f, path)) return FF_WRITE_PROTECTED_DISK;
    if (i < 0) return RX_DOS_NOT_FOUND;
    f->e[i].prot = prot; return 0;
}
static long ff_w_note(void *c, const char *path, const char *comment) {
    fakefs *f = c; int i = ff_find(f, path);
    f->writes++;
    if (ff_wprot(f, path)) return FF_WRITE_PROTECTED_DISK;
    if (i < 0) return RX_DOS_NOT_FOUND;
    snprintf(f->e[i].comment, sizeof f->e[i].comment, "%s", comment); return 0;
}

static void ff_init(fakefs *f, rx_fs *fs) {
    memset(f, 0, offsetof(fakefs, e));
    memset(fs, 0, sizeof *fs);
    f->vol_free = 0xFFFFFFFFUL;
    f->folder_present = 1; f->free = 0xFFFFFFFFUL; f->fail_write_after = -1; f->open_idx = -1;
    f->read_idx = -1; f->fail_read_at = -1; f->dir_fail_after = -1;
    fs->ctx = f; fs->folder_ok = ff_folder_ok; fs->free_bytes = ff_free; fs->exists = ff_exists;
    fs->make_dir = ff_make_dir; fs->open_w = ff_open_w; fs->write = ff_write; fs->close_w = ff_close_w;
    fs->rename = ff_rename; fs->remove = ff_remove; fs->set_meta = ff_set_meta;
    fs->is_dir = ff_is_dir; fs->list = ff_list; fs->open_r = ff_open_r; fs->read = ff_read; fs->close_r = ff_close_r;
    fs->vols = ff_vols; fs->dir_open = ff_dir_open; fs->dir_next = ff_dir_next; fs->dir_close = ff_dir_close;
    fs->stat = ff_stat; fs->fault = ff_fault;
    fs->err = ff_err; fs->free_at = ff_free_at;
    fs->w_mkdir = ff_w_mkdir; fs->w_rename = ff_w_rename; fs->w_delete = ff_w_delete; fs->w_protect = ff_w_protect;
    fs->w_note = ff_w_note;

}
