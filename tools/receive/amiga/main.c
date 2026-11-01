/* Transfer (was Receive until 2.1): files from webadf, through the board, into a folder (spec 2026-10-16 §5), and
   files from the Amiga to the web app (spec 2026-10-18 §2). Template TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S:
   RECEIVE (the default, so a plain `Transfer` still receives) and SEND name the direction; both together is an error.
   Started from Workbench it opens the window, with any shift-clicked project icons queued to send; GUI with SEND does
   the same from a Shell. BROWSE lets the web app browse the Amiga's disks, read-only, for this run; with SAVE it is
   stored too (spec 2026-10-30 §2.3). WRITE also lets it change them (spec 2026-10-31 §2.4); it implies BROWSE (plan
   ruling W11), and with SAVE both are stored. A window start is a commodity (cx.c, Transfer 2.7); from Workbench its
   icon's tool types CX_POPUP, CX_POPKEY, CX_PRIORITY and TO apply (Read and Write never come from tool types). */
#include <string.h>
#include <exec/memory.h>
#include <exec/tasks.h>
#include <workbench/startup.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "config.h"
#include "ui.h"

static const char version[] = "$VER: Transfer 2.7 (01.11.2026) webadf";

/* Shell and Workbench starts often give 4 KB of stack; the window, asl and dos calls nest deeper than that. Below the
   mode's size, run on a stack of our own (exec StackSwap, V37). Everything used across the swap is file-static. The
   Shell form measured 2,582 bytes at most on the A500 (a 1000-entry DIR, VOLS, a GET and a received file; 2026-10-31),
   so it gets 8 KB, not the window's 32 KB: on a 512 KB Amiga that is 24 KB of chip memory back. */
#define RX_STACK_GUI 32768UL
#define RX_STACK_SHELL 8192UL
static char dir[256];
static int want_gui, want_trust, rc_swapped, browse, write_on;
static STRPTR *send_files;
static cx_opts cxo;   /* the window's commodity options (Transfer 2.7): tooltypes on a Workbench start */
static struct WBArg *wb_args;
static long wb_n;
static APTR stack_mem;
static struct StackSwapStruct sss;

/* Case-insensitive, as ReadArgs matches keywords (no utility.library needed for one word). */
static int is_word(const char *s, const char *w) {
    for (; *s && *w; s++, w++) if ((*s >= 'a' && *s <= 'z' ? *s - 32 : *s) != *w) return 0;
    return *s == 0 && *w == 0;
}

static int run(void) {
    return want_gui ? gui_main(dir, wb_args, wb_n, send_files, want_trust, browse, write_on, &cxo)
                    : shell_main(dir, send_files, want_trust, browse, write_on);
}

static int run_with_stack(void) {
    struct Task *me = FindTask(NULL);
    ULONG size = want_gui ? RX_STACK_GUI : RX_STACK_SHELL;
    if ((ULONG)me->tc_SPUpper - (ULONG)me->tc_SPLower >= size) return run();
    stack_mem = AllocVec(size, MEMF_ANY);
    if (!stack_mem) return run();
    sss.stk_Lower = stack_mem;
    sss.stk_Upper = (ULONG)stack_mem + size;
    sss.stk_Pointer = (APTR)sss.stk_Upper;
    StackSwap(&sss);
    rc_swapped = run();
    StackSwap(&sss);
    FreeVec(stack_mem);
    return rc_swapped;
}

int main(int argc, char **argv) {
    LONG args[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
    struct RDArgs *rd;
    int rc, want_receive, want_browse, want_write;
    (void)version;
    cx_defaults(&cxo);
    if (argc == 0) {   /* Workbench start: libnix passes the WBStartup message as argv */
        struct WBStartup *wb = (struct WBStartup *)argv;
        cfg_load(dir, sizeof dir); want_gui = 1;
        /* CX_POPUP, CX_POPKEY, CX_PRIORITY and TO (this run only, as the Shell's TO) from Transfer's icon */
        if (wb && wb->sm_NumArgs > 0) cx_tooltypes(&wb->sm_ArgList[0], &cxo, dir, sizeof dir);
        browse = cfg_browse_load(); write_on = browse && cfg_write_load();
        if (wb && wb->sm_NumArgs > 1) { wb_args = wb->sm_ArgList + 1; wb_n = wb->sm_NumArgs - 1; }   /* [0] is Transfer */
        return run_with_stack();
    }
    rd = ReadArgs((STRPTR)"TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S,WRITE/S", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"Transfer"); return RETURN_FAIL; }
    if (args[0]) { strncpy(dir, (const char *)args[0], sizeof dir - 1); } else cfg_load(dir, sizeof dir);
    want_gui = args[2] != 0;
    cxo.shell = 1;
    send_files = (STRPTR *)args[3];
    want_trust = args[4] != 0;
    want_receive = args[5] != 0;
    want_browse = args[6] != 0;
    want_write = args[7] != 0;
    /* ReadArgs takes the word right after a keyword as its value, so in `Transfer SEND TRUST a.lha` TRUST arrives as a
       file to send (seen in FS-UAE): it is the switch, and so are RECEIVE and BROWSE. A file really named TRUST goes as DH0:TRUST. */
    if (send_files) {
        STRPTR *in, *out = send_files;
        for (in = send_files; *in; in++)
            if (is_word((const char *)*in, "TRUST")) want_trust = 1;
            else if (is_word((const char *)*in, "RECEIVE")) want_receive = 1;
            else if (is_word((const char *)*in, "BROWSE")) want_browse = 1;
            else if (is_word((const char *)*in, "WRITE")) want_write = 1;
            else *out++ = *in;
        *out = NULL;
    }
    if (want_receive && send_files && send_files[0]) {
        PutStr((STRPTR)"Transfer: RECEIVE or SEND, not both\n");
        FreeArgs(rd);
        return RETURN_ERROR;
    }
    if (want_write) want_browse = 1;   /* plan ruling W11: writing is usable only while browsing is on */
    browse = want_browse || cfg_browse_load();
    write_on = browse && (want_write || cfg_write_load());
    if (args[1] && want_browse && cfg_browse_save(1) != 0) PutStr((STRPTR)"Could not save browsing to ENVARC:\n");
    if (args[1] && want_write && cfg_write_save(1) != 0) PutStr((STRPTR)"Could not save writing to ENVARC:\n");
    if (args[1] && cfg_save(dir) != 0) PutStr((STRPTR)"Could not save the folder to ENVARC:\n");
    rc = run_with_stack();
    FreeArgs(rd);   /* after the run: SEND's names live in rd */
    return rc;
}
