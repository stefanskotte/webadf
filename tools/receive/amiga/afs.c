/* rx_fs over dos.library (V37). Paths are the folder joined with the core's '/'-separated relative path. */
#include <string.h>
#include <exec/memory.h>
#include <dos/dosextens.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "afs.h"

/* Plan ruling T8: while Transfer reads for the web app, a drive whose disk went never opens "Please insert volume" on
   the Amiga's screen -- it would stop Transfer, and the board, until someone clicks. The call fails instead. */
static APTR quiet_on(void) {
    struct Process *p = (struct Process *)FindTask(NULL);
    APTR w = p->pr_WindowPtr;
    p->pr_WindowPtr = (APTR)-1;
    return w;
}
static void quiet_off(APTR w) { ((struct Process *)FindTask(NULL))->pr_WindowPtr = w; }
static unsigned long mul_cap(unsigned long a, unsigned long b) { return (b && a > 0xFFFFFFFFUL / b) ? 0xFFFFFFFFUL : a * b; }

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
    APTR w = quiet_on();
    c->rh = Open((STRPTR)local, MODE_OLDFILE);   /* MODE_OLDFILE takes a shared lock */
    if (!c->rh) { quiet_off(w); return -1; }
    fib = AllocDosObject(DOS_FIB, NULL);
    if (!fib || !ExamineFH(c->rh, fib) || fib->fib_DirEntryType > 0) {
        if (fib) FreeDosObject(DOS_FIB, fib);
        Close(c->rh); c->rh = 0;
        quiet_off(w);
        return -1;
    }
    info->size = (unsigned long)fib->fib_Size; info->prot = (unsigned long)fib->fib_Protection;
    info->days = (unsigned long)fib->fib_Date.ds_Days; info->mins = (unsigned long)fib->fib_Date.ds_Minute;
    info->ticks = (unsigned long)fib->fib_Date.ds_Tick;
    strncpy(info->comment, (const char *)fib->fib_Comment, RX_COMMENT_MAX); info->comment[RX_COMMENT_MAX] = 0;
    FreeDosObject(DOS_FIB, fib);
    quiet_off(w);
    return 0;
}
static long a_read(void *x, unsigned char *b, unsigned long n) {
    APTR w = quiet_on();
    LONG got = Read(((afs_ctx *)x)->rh, b, (LONG)n);
    quiet_off(w);
    return got < 0 ? -1 : (long)got;
}
/* Quiet too (plan ruling T8): closing a file on a disk taken out mid-copy must not put up a requester. */
static void a_close_r(void *x) {
    afs_ctx *c = x;
    if (c->rh) { APTR w = quiet_on(); Close(c->rh); c->rh = 0; quiet_off(w); }
}
/* --- Protocol 3 (spec 2026-10-30 §2.2): browsing, read-only, shared locks only --- */
static void bstr(BSTR b, char *out, unsigned cap) {
    const UBYTE *p = (const UBYTE *)BADDR(b);
    unsigned n = p ? p[0] : 0;
    if (n > cap - 1) n = cap - 1;
    if (n) memcpy(out, p + 1, n);
    out[n] = 0;
}
/* The size and free bytes of the volume in dev ("DH0:"), as a_free counts them; RAM: is free memory (ruling T11). */
static void vol_sizes(const char *dev, unsigned long *size, unsigned long *fr) {
    BPTR l = Lock((STRPTR)dev, SHARED_LOCK);
    struct InfoData *id;
    *size = 0; *fr = 0;
    if (!l) return;
    if (((struct FileLock *)BADDR(l))->fl_Task == DeviceProc((STRPTR)"RAM:")) {
        ULONG mem = AvailMem(MEMF_ANY);
        *fr = mem > 65536UL ? mem - 65536UL : 0;
        UnLock(l);
        return;
    }
    id = AllocVec(sizeof *id, MEMF_PUBLIC | MEMF_CLEAR);
    if (id && Info(l, id)) {
        unsigned long bpb = (unsigned long)id->id_BytesPerBlock;
        *size = mul_cap((unsigned long)id->id_NumBlocks, bpb);
        *fr = mul_cap((unsigned long)(id->id_NumBlocks - id->id_NumBlocksUsed), bpb);
    }
    if (id) FreeVec(id);
    UnLock(l);
}
/* Mounted volumes (a handler task: a disk is in), each with the device whose handler it shares ("DF1:"). Names are
   copied under the DOS list lock; Lock and Info run after it is let go. */
static int a_vols(void *x, rx_vol *out, int max) {
    static struct MsgPort *task[RX_VOLS_MAX];
    struct DosList *head, *dl;
    int n = 0, i;
    APTR w;
    (void)x;
    if (max > RX_VOLS_MAX) max = RX_VOLS_MAX;
    head = LockDosList(LDF_VOLUMES | LDF_DEVICES | LDF_READ);
    for (dl = head; n < max && (dl = NextDosEntry(dl, LDF_VOLUMES)) != NULL; ) {
        if (!dl->dol_Task) continue;   /* its disk was taken out */
        memset(&out[n], 0, sizeof out[n]);
        bstr(dl->dol_Name, out[n].name, sizeof out[n].name);
        out[n].days = (unsigned long)dl->dol_misc.dol_volume.dol_VolumeDate.ds_Days;
        out[n].mins = (unsigned long)dl->dol_misc.dol_volume.dol_VolumeDate.ds_Minute;
        out[n].ticks = (unsigned long)dl->dol_misc.dol_volume.dol_VolumeDate.ds_Tick;
        task[n++] = dl->dol_Task;
    }
    for (dl = head; (dl = NextDosEntry(dl, LDF_DEVICES)) != NULL; )
        for (i = 0; i < n; i++)
            if (!out[i].device[0] && dl->dol_Task == task[i]) {
                bstr(dl->dol_Name, out[i].device, sizeof out[i].device - 1);
                strcat(out[i].device, ":");
            }
    UnLockDosList(LDF_VOLUMES | LDF_DEVICES | LDF_READ);
    w = quiet_on();
    for (i = 0; i < n; i++) if (out[i].device[0]) vol_sizes(out[i].device, &out[i].size, &out[i].free);
    quiet_off(w);
    return n;
}
static void fill_dent(const struct FileInfoBlock *f, rx_dent *e) {
    e->is_dir = f->fib_DirEntryType > 0;
    e->size = e->is_dir ? 0 : (unsigned long)f->fib_Size;
    e->prot = (unsigned long)f->fib_Protection;
    e->days = (unsigned long)f->fib_Date.ds_Days; e->mins = (unsigned long)f->fib_Date.ds_Minute;
    e->ticks = (unsigned long)f->fib_Date.ds_Tick;
    strncpy(e->name, (const char *)f->fib_FileName, sizeof e->name - 1); e->name[sizeof e->name - 1] = 0;
    strncpy(e->comment, (const char *)f->fib_Comment, RX_COMMENT_MAX); e->comment[RX_COMMENT_MAX] = 0;
}
/* Quiet too (plan ruling T8): letting go of a drawer on a disk taken out mid-listing must not put up a requester. */
static void a_dir_close(void *x) {
    afs_ctx *c = x;
    APTR w = quiet_on();
    if (c->dfib) { FreeDosObject(DOS_FIB, c->dfib); c->dfib = NULL; }
    if (c->dl) { UnLock(c->dl); c->dl = 0; }
    quiet_off(w);
}
static long a_dir_open(void *x, const char *path) {
    afs_ctx *c = x;
    APTR w = quiet_on();
    long e = 0;
    c->dl = Lock((STRPTR)path, SHARED_LOCK);
    if (!c->dl) e = IoErr();
    else if ((c->dfib = AllocDosObject(DOS_FIB, NULL)) == NULL) e = ERROR_NO_FREE_STORE;
    else if (!Examine(c->dl, c->dfib)) e = IoErr();
    else if (c->dfib->fib_DirEntryType <= 0) e = ERROR_OBJECT_WRONG_TYPE;
    quiet_off(w);
    if (e == 0 && c->dl) return 0;
    a_dir_close(c);
    return e ? e : ERROR_OBJECT_NOT_FOUND;
}
static long a_dir_next(void *x, rx_dent *e) {
    afs_ctx *c = x;
    APTR w = quiet_on();
    long r = 1;
    if (ExNext(c->dl, c->dfib)) fill_dent(c->dfib, e);
    else { LONG err = IoErr(); r = err == ERROR_NO_MORE_ENTRIES ? 0 : -(err ? err : ERROR_OBJECT_NOT_FOUND); }
    quiet_off(w);
    return r;
}
static long a_stat(void *x, const char *path, rx_finfo *info, int *is_dir) {
    APTR w = quiet_on();
    BPTR l = Lock((STRPTR)path, SHARED_LOCK);
    struct FileInfoBlock *f = NULL;
    long e = 0;
    (void)x;
    if (!l) e = IoErr();
    else if ((f = AllocDosObject(DOS_FIB, NULL)) == NULL) e = ERROR_NO_FREE_STORE;
    else if (!Examine(l, f)) e = IoErr();
    else {
        *is_dir = f->fib_DirEntryType > 0;
        info->size = (unsigned long)f->fib_Size; info->prot = (unsigned long)f->fib_Protection;
        info->days = (unsigned long)f->fib_Date.ds_Days; info->mins = (unsigned long)f->fib_Date.ds_Minute;
        info->ticks = (unsigned long)f->fib_Date.ds_Tick;
        strncpy(info->comment, (const char *)f->fib_Comment, RX_COMMENT_MAX); info->comment[RX_COMMENT_MAX] = 0;
    }
    if (f) FreeDosObject(DOS_FIB, f);
    if (l) UnLock(l);
    quiet_off(w);
    return (!l && !e) ? ERROR_OBJECT_NOT_FOUND : e;
}
static void a_fault(void *x, long err, char *text, unsigned cap) {
    (void)x;
    if (Fault(err, NULL, (STRPTR)text, (LONG)cap) <= 0) text[0] = 0;
}
void afs_base_name(const char *path, char *out) { rx_base_name(path, out); }   /* the rule is the core's, host-tested */
void afs_set_root(afs_ctx *c, const char *root) { strncpy(c->root, root, sizeof c->root - 1); c->root[sizeof c->root - 1] = 0; }
void afs_init(afs_ctx *c, rx_fs *fs, const char *root) {
    memset(c, 0, sizeof *c);
    afs_set_root(c, root);
    fs->ctx = c; fs->folder_ok = a_folder_ok; fs->free_bytes = a_free; fs->exists = a_exists; fs->make_dir = a_make_dir;
    fs->open_w = a_open_w; fs->write = a_write; fs->close_w = a_close_w; fs->rename = a_rename; fs->remove = a_remove;
    fs->set_meta = a_set_meta;
    fs->is_dir = a_is_dir; fs->list = a_list; fs->open_r = a_open_r; fs->read = a_read; fs->close_r = a_close_r;
    fs->vols = a_vols; fs->dir_open = a_dir_open; fs->dir_next = a_dir_next; fs->dir_close = a_dir_close;
    fs->stat = a_stat; fs->fault = a_fault;
}
