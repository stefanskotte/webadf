/* The folder setting: ENV:webadf/ReceiveDir (this boot), ENVARC:webadf/ReceiveDir (kept). Plain files, so it
   works on V37, where SetVar's GVF_SAVE_VAR does not exist. */
#include <string.h>
#include <proto/dos.h>
#include "config.h"

static int read_file(const char *name, char *dir, unsigned cap) {
    BPTR f = Open((STRPTR)name, MODE_OLDFILE);
    LONG n;
    if (!f) return 0;
    n = Read(f, dir, (LONG)cap - 1);
    Close(f);
    if (n <= 0) return 0;
    dir[n] = 0;
    while (n > 0 && (dir[n - 1] == '\n' || dir[n - 1] == '\r' || dir[n - 1] == ' ')) dir[--n] = 0;
    return n > 0;
}
void cfg_load(char *dir, unsigned cap) {
    if (read_file("ENV:webadf/ReceiveDir", dir, cap)) return;
    if (read_file("ENVARC:webadf/ReceiveDir", dir, cap)) return;
    strncpy(dir, "RAM:", cap);
}
static int write_one(const char *base, const char *dir) {
    char p[64]; BPTR l, f; LONG n = (LONG)strlen(dir), w;
    strcpy(p, base); strcat(p, "webadf");
    l = CreateDir((STRPTR)p);
    if (l) UnLock(l);
    strcat(p, "/ReceiveDir");
    f = Open((STRPTR)p, MODE_NEWFILE);
    if (!f) return -1;
    w = Write(f, (APTR)dir, n);
    Close(f);
    return w == n ? 0 : -1;
}
int cfg_save(const char *dir) {
    write_one("ENV:", dir);
    return write_one("ENVARC:", dir);
}
