/* Receive: files from webadf, through the board, into a folder (spec 2026-10-16 §5). Template TO/K,SAVE/S,GUI/S;
   started from Workbench it opens the window. */
#include <string.h>
#include <exec/memory.h>
#include <exec/tasks.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "config.h"
#include "ui.h"

static const char version[] = "$VER: Receive 1.0 (16.10.2026) webadf";

/* Shell and Workbench starts often give 4 KB of stack; the window, asl and dos calls nest deeper than that. Below
   RX_STACK, run on a stack of our own (exec StackSwap, V37). Everything used across the swap is file-static. */
#define RX_STACK 32768UL
static char dir[256];
static int want_gui, rc_swapped;
static APTR stack_mem;
static struct StackSwapStruct sss;

static int run(void) { return want_gui ? gui_main(dir) : shell_main(dir); }

static int run_with_stack(void) {
    struct Task *me = FindTask(NULL);
    if ((ULONG)me->tc_SPUpper - (ULONG)me->tc_SPLower >= RX_STACK) return run();
    stack_mem = AllocVec(RX_STACK, MEMF_ANY);
    if (!stack_mem) return run();
    sss.stk_Lower = stack_mem;
    sss.stk_Upper = (ULONG)stack_mem + RX_STACK;
    sss.stk_Pointer = (APTR)sss.stk_Upper;
    StackSwap(&sss);
    rc_swapped = run();
    StackSwap(&sss);
    FreeVec(stack_mem);
    return rc_swapped;
}

int main(int argc, char **argv) {
    LONG args[3] = { 0, 0, 0 };
    struct RDArgs *rd;
    (void)argv; (void)version;
    if (argc == 0) { cfg_load(dir, sizeof dir); want_gui = 1; return run_with_stack(); }   /* Workbench start */
    rd = ReadArgs((STRPTR)"TO/K,SAVE/S,GUI/S", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"Receive"); return RETURN_FAIL; }
    if (args[0]) { strncpy(dir, (const char *)args[0], sizeof dir - 1); } else cfg_load(dir, sizeof dir);
    if (args[1] && cfg_save(dir) != 0) PutStr((STRPTR)"Could not save the folder to ENVARC:\n");
    want_gui = args[2] != 0;
    FreeArgs(rd);
    return run_with_stack();
}
