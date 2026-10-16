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
void afs_set_root(afs_ctx *c, const char *root) { strncpy(c->root, root, sizeof c->root - 1); c->root[sizeof c->root - 1] = 0; }
void afs_init(afs_ctx *c, rx_fs *fs, const char *root) {
    memset(c, 0, sizeof *c);
    afs_set_root(c, root);
    fs->ctx = c; fs->folder_ok = a_folder_ok; fs->free_bytes = a_free; fs->exists = a_exists; fs->make_dir = a_make_dir;
    fs->open_w = a_open_w; fs->write = a_write; fs->close_w = a_close_w; fs->rename = a_rename; fs->remove = a_remove;
    fs->set_meta = a_set_meta;
}
