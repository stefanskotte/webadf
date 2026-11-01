#ifndef CX_H
#define CX_H
/* Transfer's window as a commodity (Transfer 2.7, plan 2026-11-01): Exchange shows, hides, disables and kills it, a
   hotkey shows it, and a second start shows the first one's window instead of running twice. The Shell form has none. */
#include <exec/types.h>
#include <workbench/startup.h>
typedef struct cx_opts {
    int popup;          /* CX_POPUP: open the window at start (default 1) */
    long pri;           /* CX_PRIORITY (default 0) */
    char popkey[64];    /* CX_POPKEY (default "ctrl alt w"); "" none */
    int shell;          /* started from a Shell (Transfer GUI): say so when another Transfer runs */
} cx_opts;
enum { CX_SHOW = 1, CX_HIDE = 2, CX_QUIT = 4, CX_ENABLE = 8, CX_DISABLE = 16 };
void cx_defaults(cx_opts *o);
/* A Workbench start: CX_POPUP, CX_POPKEY, CX_PRIORITY and TO from Transfer's own icon (TO into dir[cap]). */
void cx_tooltypes(const struct WBArg *self, cx_opts *o, char *dir, unsigned cap);
/* 0 the broker is up; 1 another Transfer has it (and was told to show its window); -1 no commodities.library or no
   broker (the window then runs as 2.6 did). cx_hotkey_bad() is 1 when CX_POPKEY could not be read. */
int cx_open(const cx_opts *o);
int cx_hotkey_bad(void);
ULONG cx_sigmask(void);
int cx_take(void);     /* what Exchange or the hotkey asked since the last call: CX_* bits */
void cx_close(void);
#endif
