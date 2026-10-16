/* Receive in a Shell: one line per file, Ctrl-C stops. */
#include <proto/dos.h>
#include "afs.h"
#include "net.h"
#include "ui.h"

static void sh_status(void *u, const char *t) { (void)u; PutStr((STRPTR)t); PutStr((STRPTR)"\n"); Flush(Output()); }
static void sh_event(void *u, const rx_event *e, rx_session *s) {
    LONG args[3];
    (void)u; (void)s;
    if (e->kind == RX_EV_DONE) {
        args[0] = (LONG)e->path; args[1] = (LONG)e->size;
        VPrintf((STRPTR)"%s  %lu bytes  OK\n", args);
    } else if (e->kind == RX_EV_FAILED) {
        args[0] = (LONG)e->path; args[1] = (LONG)e->text;
        VPrintf((STRPTR)"%s  ERR %s\n", args);
    } else if (e->kind == RX_EV_HELLO) {
        PutStr((STRPTR)"Board connected\n");
    }
    Flush(Output());
}
static int sh_signal(void *u, ULONG sigs) { (void)u; (void)sigs; return 0; }

int shell_main(const char *dir) {
    static afs_ctx ctx; static rx_fs fs; static rx_session s;
    net_ui ui = { NULL, sh_event, sh_status, 0, sh_signal };
    LONG args[1];
    if (net_open() != 0) { PutStr((STRPTR)"No TCP/IP stack running (bsdsocket.library)\n"); return RETURN_FAIL; }
    afs_init(&ctx, &fs, dir);
    if (!fs.folder_ok(&ctx)) { PutStr((STRPTR)"Folder not found\n"); net_close(); return RETURN_FAIL; }
    args[0] = (LONG)dir;
    VPrintf((STRPTR)"Receive: saving into %s. Ctrl-C to stop.\n", args);
    if (net_run(&ui, &ctx, &fs, &s) != 0) { PutStr((STRPTR)"Could not listen on port 6800\n"); net_close(); return RETURN_FAIL; }
    PutStr((STRPTR)"Stopped.\n");
    net_close();
    return RETURN_OK;
}
