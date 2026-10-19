/* rx_fs over dos.library (V37). Paths are the folder joined with the core's '/'-separated relative path. */
#include <string.h>
#include <exec/memory.h>
#include <dos/dosextens.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "afs.h"

static void join(afs_ctx *c, const char *rel, char *out) {
    size_t n;
    strcpy(out, c->root);
    n = strlen(out);
    if (n && out[n - 1] != ':' && out[n - 1] != '/' && rel[0]) strcat(out, "/");
    strcat(out, rel);
}
static int a_folder_ok(void *x) {
    afs_ctx *c = x;
    BPTR l = Lock((STRPTR)c->root, SHARED_LOCK);
    struct FileInfoBlock *fib;
    int ok = 0;
    if (!l) return 0;
    fib = AllocDosObject(DOS_FIB, NULL);
    if (fib) { if (Examine(l, fib)) ok = fib->fib_DirEntryType > 0; FreeDosObject(DOS_FIB, fib); }
    UnLock(l);
    return ok;
}
static unsigned long a_free(void *x) {
    afs_ctx *c = x;
    BPTR l = Lock((STRPTR)c->root, SHARED_LOCK);
    struct InfoData *id;
    unsigned long r = 0xFFFFFFFFUL;
    if (!l) return 0;
    /* The RAM disk always reports itself full (it grows into free memory), so for RAM: the limit is free RAM,
       less 64 KB left for the system. */
    if (((struct FileLock *)BADDR(l))->fl_Task == DeviceProc((STRPTR)"RAM:")) {
        ULONG mem = AvailMem(MEMF_ANY);
        UnLock(l);
        return mem > 65536UL ? mem - 65536UL : 0;
    }
    id = AllocVec(sizeof *id, MEMF_PUBLIC | MEMF_CLEAR);
    if (id && Info(l, id)) {
        unsigned long blocks = (unsigned long)(id->id_NumBlocks - id->id_NumBlocksUsed);
        unsigned long bpb = (unsigned long)id->id_BytesPerBlock;
        r = (bpb && blocks > 0xFFFFFFFFUL / bpb) ? 0xFFFFFFFFUL : blocks * bpb;
    }
    if (id) FreeVec(id);
    UnLock(l);
    return r;
}
static int a_exists(void *x, const char *rel) {
    char p[512]; BPTR l;
    join(x, rel, p);
    l = Lock((STRPTR)p, SHARED_LOCK);
    if (!l) return 0;
    UnLock(l);
    return 1;
}
static int a_make_dir(void *x, const char *rel) {
    char p[512]; BPTR l;
    join(x, rel, p);
    l = CreateDir((STRPTR)p);
    if (l) { UnLock(l); return 0; }
    return a_exists(x, rel) ? 0 : -1;
}
static int a_open_w(void *x, const char *rel) {
    afs_ctx *c = x; char p[512];
    join(c, rel, p);
    c->fh = Open((STRPTR)p, MODE_NEWFILE);
    return c->fh ? 0 : -1;
}
static int a_write(void *x, const unsigned char *b, unsigned long n) {
    return Write(((afs_ctx *)x)->fh, (APTR)b, (LONG)n) == (LONG)n ? 0 : -1;
}
static int a_close_w(void *x) {
    afs_ctx *c = x; LONG ok = Close(c->fh);
    c->fh = 0;
    return ok ? 0 : -1;
}
static int a_rename(void *x, const char *from, const char *to) {
    char a[512], b[512];
    join(x, from, a); join(x, to, b);
    return Rename((STRPTR)a, (STRPTR)b) ? 0 : -1;
}
static int a_remove(void *x, const char *rel) { char p[512]; join(x, rel, p); return DeleteFile((STRPTR)p) ? 0 : -1; }
static int a_set_meta(void *x, const char *rel, unsigned long prot, const char *comment) {
    char p[512]; int ok;
    join(x, rel, p);
    ok = SetProtection((STRPTR)p, (LONG)prot) != 0;
    if (comment[0]) ok = SetComment((STRPTR)p, (STRPTR)comment) != 0 && ok;
    return ok ? 0 : -1;
}
/* Protocol 2 (spec 2026-10-18 §2): the Amiga's own paths, read with a shared lock in 8 KB blocks. */
static int a_is_dir(void *x, const char *local) {
    BPTR l = Lock((STRPTR)local, SHARED_LOCK); struct FileInfoBlock *fib; int r = -1;
    (void)x;
    if (!l) return -1;
    fib = AllocDosObject(DOS_FIB, NULL);
    if (fib) { if (Examine(l, fib)) r = fib->fib_DirEntryType > 0 ? 1 : 0; FreeDosObject(DOS_FIB, fib); }
    UnLock(l);
    return r;
}
static int a_list(void *x, const char *local, rx_list_fn each, void *u) {
    BPTR l = Lock((STRPTR)local, SHARED_LOCK); struct FileInfoBlock *fib; int r = -1;
    (void)x;
    if (!l) return -1;
    fib = AllocDosObject(DOS_FIB, NULL);
    if (fib && Examine(l, fib) && fib->fib_DirEntryType > 0) {
        r = 0;
        while (ExNext(l, fib)) each(u, (const char *)fib->fib_FileName, fib->fib_DirEntryType > 0);
    }
    if (fib) FreeDosObject(DOS_FIB, fib);
    UnLock(l);
    return r;
}
static int a_open_r(void *x, const char *local, rx_finfo *info) {
    afs_ctx *c = x; struct FileInfoBlock *fib;
    c->rh = Open((STRPTR)local, MODE_OLDFILE);   /* MODE_OLDFILE takes a shared lock */
    if (!c->rh) return -1;
    fib = AllocDosObject(DOS_FIB, NULL);
    if (!fib || !ExamineFH(c->rh, fib) || fib->fib_DirEntryType > 0) {
        if (fib) FreeDosObject(DOS_FIB, fib);
        Close(c->rh); c->rh = 0;
        return -1;
    }
    info->size = (unsigned long)fib->fib_Size; info->prot = (unsigned long)fib->fib_Protection;
    info->days = (unsigned long)fib->fib_Date.ds_Days; info->mins = (unsigned long)fib->fib_Date.ds_Minute;
    info->ticks = (unsigned long)fib->fib_Date.ds_Tick;
    strncpy(info->comment, (const char *)fib->fib_Comment, RX_COMMENT_MAX); info->comment[RX_COMMENT_MAX] = 0;
    FreeDosObject(DOS_FIB, fib);
    return 0;
}
static long a_read(void *x, unsigned char *b, unsigned long n) { LONG got = Read(((afs_ctx *)x)->rh, b, (LONG)n); return got < 0 ? -1 : (long)got; }
static void a_close_r(void *x) { afs_ctx *c = x; if (c->rh) { Close(c->rh); c->rh = 0; } }
void afs_base_name(const char *path, char *out) { rx_base_name(path, out); }   /* the rule is the core's, host-tested */
void afs_set_root(afs_ctx *c, const char *root) { strncpy(c->root, root, sizeof c->root - 1); c->root[sizeof c->root - 1] = 0; }
void afs_init(afs_ctx *c, rx_fs *fs, const char *root) {
    memset(c, 0, sizeof *c);
    afs_set_root(c, root);
    fs->ctx = c; fs->folder_ok = a_folder_ok; fs->free_bytes = a_free; fs->exists = a_exists; fs->make_dir = a_make_dir;
    fs->open_w = a_open_w; fs->write = a_write; fs->close_w = a_close_w; fs->rename = a_rename; fs->remove = a_remove;
    fs->set_meta = a_set_meta;
    fs->is_dir = a_is_dir; fs->list = a_list; fs->open_r = a_open_r; fs->read = a_read; fs->close_r = a_close_r;
}
