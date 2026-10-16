/* Receive: files from webadf, through the board, into a folder (spec 2026-10-16 §5). Template TO/K,SAVE/S. */
#include <string.h>
#include <proto/dos.h>
#include "config.h"
#include "ui.h"

static const char version[] = "$VER: Receive 1.0 (16.10.2026) webadf";

int main(int argc, char **argv) {
    static char dir[256];
    LONG args[3] = { 0, 0, 0 };
    struct RDArgs *rd;
    int rc;
    (void)argv; (void)version;
    if (argc == 0) return RETURN_FAIL;   /* Workbench start: Task 5 */
    rd = ReadArgs((STRPTR)"TO/K,SAVE/S", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"Receive"); return RETURN_FAIL; }
    if (args[0]) { strncpy(dir, (const char *)args[0], sizeof dir - 1); } else cfg_load(dir, sizeof dir);
    if (args[1] && cfg_save(dir) != 0) PutStr((STRPTR)"Could not save the folder to ENVARC:\n");
    FreeArgs(rd);
    rc = shell_main(dir);
    return rc;
}
