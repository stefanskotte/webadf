#ifndef UI_H
#define UI_H
#include <exec/types.h>
#include <workbench/startup.h>
int shell_main(const char *dir, STRPTR *send, int trust);
int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send);
#endif
