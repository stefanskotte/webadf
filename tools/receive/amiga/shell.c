/* Receive in a Shell (spec 2026-10-16 §5, 2026-10-18 §2): one line per file; Ctrl-C stops. With SEND the files go to
   the web app: handed to a Receive already running (port webadf.Receive), or sent by this run, which listens on 6800
   itself, waits up to 60 s for the board, and returns 0 (all sent), 5 (some) or 10 (none). */
#include <string.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "afs.h"
#include "clock.h"
#include "config.h"
#include "ipc.h"
#include "net.h"
#include "ui.h"

static struct { int send_mode, asked, ok, done, heard, quit, old_said; ULONG t0; } sh;
static rx_upq q;
static rx_session sess;

static void sh_status(void *u, const char *t) { (void)u; PutStr((STRPTR)t); PutStr((STRPTR)"\n"); Flush(Output()); }
static void sh_event(void *u, const rx_event *e, rx_session *s) {
    LONG a[3]; char k4[5];
    (void)u; (void)s;
    switch (e->kind) {
    case RX_EV_DONE: a[0] = (LONG)e->path; a[1] = (LONG)e->size; VPrintf((STRPTR)"%s  %lu bytes  OK\n", a); break;
    case RX_EV_FAILED: a[0] = (LONG)e->path; a[1] = (LONG)e->text; VPrintf((STRPTR)"%s  ERR %s\n", a); break;
    case RX_EV_HELLO: PutStr((STRPTR)"Board connected\n"); break;
    case RX_EV_TRUST:
        sh.heard = 1;
        rx_key4(e->key, k4); a[0] = (LONG)k4;
        if (!strcmp(e->code, "new")) {
            if (cfg_key_save(e->key) != 0) PutStr((STRPTR)"Could not save the board key to ENVARC:\n");
            VPrintf((STRPTR)"Trusted board %s\n", a);
        } else if (!strcmp(e->code, "ok")) VPrintf((STRPTR)"Board key %s\n", a);
        else if (!strcmp(e->code, "other")) { PutStr((STRPTR)"Another board or computer connected -- not sending\n"); if (sh.send_mode) sh.quit = 1; }
        else {
            /* Every board before 1.19.0 connects this way to send files down: say it only when something is to go up,
               and once a run. */
            if ((sh.send_mode || q.n > 0) && !sh.old_said) {
                PutStr((STRPTR)"This board's firmware cannot receive files (update to 1.19.0)\n");
                sh.old_said = 1;
            }
            if (sh.send_mode) sh.quit = 1;
        }
        break;
    case RX_EV_UP_DONE:
        a[0] = (LONG)e->path; a[1] = (LONG)e->size; VPrintf((STRPTR)"%s  %lu bytes  OK\n", a);
        sh.ok++; sh.done++; ipc_done(e->tag, 1, e->size, "");
        break;
    case RX_EV_UP_FAILED:
        a[0] = (LONG)e->path; a[1] = (LONG)e->text; VPrintf((STRPTR)"%s  ERR %s\n", a);
        sh.done++; ipc_done(e->tag, 0, 0, e->text);
        break;
    default: break;
    }
    Flush(Output());
}
static int sh_trust(void *u) { (void)u; if (rx_trust_now(&sess) == 0) return 0; q.trust_next = 1; return 0; }
static int sh_signal(void *u, ULONG sigs) { (void)u; if (sigs & ipc_sigmask()) ipc_take(&q, NULL, sh_trust, NULL); return 0; }
static int sh_pass(void *u, rx_session *s, int connected) {
    (void)u; (void)s; (void)connected;
    if (!sh.send_mode) return 0;
    if (sh.quit || sh.done >= sh.asked) return 1;
    if (!sh.heard && rx_now_secs() - sh.t0 > 60) { PutStr((STRPTR)"No board connected within 60 s\n"); return 1; }
    return 0;
}
static int send_rc(void) { return sh.ok == sh.asked ? RETURN_OK : sh.ok ? RETURN_WARN : RETURN_ERROR; }

int shell_main(const char *dir, STRPTR *send, int trust) {
    static afs_ctx ctx; static rx_fs fs;
    net_ui ui = { NULL, sh_event, sh_status, 0, sh_signal, sh_pass, NULL };
    char key[RX_KEY_HEX + 8];
    LONG args[1];
    int i, rc;
    afs_init(&ctx, &fs, dir);
    cfg_key_load(key, sizeof key);
    rx_upq_init(&q, key);
    if (trust) q.trust_next = 1;
    if (send && send[0]) {
        sh.send_mode = 1;
        for (i = 0; send[i]; i++) {
            char name[RX_PART_MAX + 1];
            int k;
            afs_base_name((const char *)send[i], name);
            k = rx_up_add_tree(&q, &fs, (const char *)send[i], name, NULL, NULL);
            if (k <= 0) { args[0] = (LONG)send[i]; VPrintf((STRPTR)"%s  ERR cannot read it\n", args); sh.asked++; sh.done++; }
            else sh.asked += k;
        }
        if (q.n == 0) return RETURN_ERROR;
        if (ipc_running()) {
            int ok = 0, n = (int)q.n;
            if (ipc_hand_off(&q, trust, &ok) >= 0) { sh.ok += ok; sh.done += n; return send_rc(); }
        }
        if (net_open() != 0) { PutStr((STRPTR)"No TCP/IP stack running (bsdsocket.library)\n"); return RETURN_ERROR; }
        PutStr((STRPTR)"Waiting for the board\n"); Flush(Output());
        sh.t0 = rx_now_secs();
        rc = net_run(&ui, &ctx, &fs, &sess, &q);
        net_close();
        if (rc != 0) { PutStr((STRPTR)"Could not listen on port 6800\n"); return RETURN_ERROR; }
        return send_rc();
    }
    if (net_open() != 0) { PutStr((STRPTR)"No TCP/IP stack running (bsdsocket.library)\n"); return RETURN_FAIL; }
    if (!fs.folder_ok(&ctx)) { PutStr((STRPTR)"Folder not found\n"); net_close(); return RETURN_FAIL; }
    if (ipc_open() == 0) ui.extra_sigs = ipc_sigmask();
    args[0] = (LONG)dir;
    VPrintf((STRPTR)"Receive: saving into %s. Ctrl-C to stop.\n", args);
    rc = net_run(&ui, &ctx, &fs, &sess, &q);
    ipc_close();
    if (rc != 0) { PutStr((STRPTR)"Could not listen on port 6800\n"); net_close(); return RETURN_FAIL; }
    PutStr((STRPTR)"Stopped.\n");
    net_close();
    return RETURN_OK;
}
