#ifndef UI_H
#define UI_H
#include <exec/types.h>
#include <workbench/startup.h>
#include "cx.h"
int shell_main(const char *dir, STRPTR *send, int trust, int browse, int write);
int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send, int trust, int browse, int write, const cx_opts *cx);
#endif
