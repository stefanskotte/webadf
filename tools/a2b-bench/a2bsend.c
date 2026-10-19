/* a2bsend: the Amiga side of plan 2026-10-19 Task 1 (spec 2026-10-18 §10 step 0). Sends BYTES of a pattern (default
   1 MB), or a FILE, to HOST:PORT over bsdsocket and prints the time. Kickstart 2.04+, 68000. Bench only.
   Template: HOST/A,PORT/N/A,BYTES/N,FILE/K */
#include <string.h>
#include <exec/types.h>
#include <dos/dos.h>
#include <dos/dosextens.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/socket.h>
#include <sys/socket.h>
#include <netinet/in.h>

struct Library *SocketBase;
static unsigned char buf[8192];
static const char version[] = "$VER: a2bsend 1.0 (19.10.2026) webadf bench";

/* Ticks (1/50 s) since 1978: a run lasts minutes, so this never wraps in one. */
static ULONG ticks(void) {
    struct DateStamp d;
    DateStamp(&d);
    return ((ULONG)d.ds_Days * 1440UL + (ULONG)d.ds_Minute) * 3000UL + (ULONG)d.ds_Tick;
}

int main(void) {
    LONG args[4] = { 0, 0, 0, 0 }, out[4], rc = RETURN_FAIL, s = -1;
    struct RDArgs *rd;
    struct sockaddr_in a;
    BPTR fh = 0;
    ULONG total, sent = 0, t0, dt, i;
    (void)version;
    rd = ReadArgs((STRPTR)"HOST/A,PORT/N/A,BYTES/N,FILE/K", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"a2bsend"); return RETURN_FAIL; }
    total = args[2] ? *(ULONG *)args[2] : 1048576UL;
    if (args[3]) {
        struct FileInfoBlock *fib = AllocDosObject(DOS_FIB, NULL);
        fh = Open((STRPTR)args[3], MODE_OLDFILE);
        if (fib && fh && ExamineFH(fh, fib)) total = (ULONG)fib->fib_Size;
        else { PutStr((STRPTR)"a2bsend: cannot read FILE\n"); if (fib) FreeDosObject(DOS_FIB, fib); goto out; }
        FreeDosObject(DOS_FIB, fib);
    }
    for (i = 0; i < sizeof buf; i++) buf[i] = (unsigned char)(i * 31 + 7);
    SocketBase = OpenLibrary((STRPTR)"bsdsocket.library", 3);
    if (!SocketBase) { PutStr((STRPTR)"a2bsend: no TCP/IP stack running (bsdsocket.library)\n"); goto out; }
    s = socket(AF_INET, SOCK_STREAM, 0);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((UWORD)*(LONG *)args[1]);
    a.sin_addr.s_addr = inet_addr((STRPTR)args[0]);
    if (s < 0 || connect(s, (struct sockaddr *)&a, sizeof a) != 0) { PutStr((STRPTR)"a2bsend: cannot connect\n"); goto out; }
    t0 = ticks();
    while (sent < total) {
        LONG n = total - sent > sizeof buf ? (LONG)sizeof buf : (LONG)(total - sent), k = 0;
        if (SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) { PutStr((STRPTR)"a2bsend: stopped\n"); break; }
        if (fh && Read(fh, buf, n) != n) { PutStr((STRPTR)"a2bsend: read failed\n"); break; }
        while (k < n) { LONG w = send(s, buf + k, n - k, 0); if (w <= 0) break; k += w; }
        if (k < n) { PutStr((STRPTR)"a2bsend: send failed\n"); break; }
        sent += (ULONG)n;
    }
    dt = ticks() - t0;
    if (dt == 0) dt = 1;
    out[0] = (LONG)sent; out[1] = (LONG)(dt / 50); out[2] = (LONG)((dt % 50) * 2); out[3] = (LONG)(sent * 50UL / dt);
    VPrintf((STRPTR)"a2bsend: %lu bytes in %lu.%02lu s = %lu B/s\n", out);
    rc = sent == total ? RETURN_OK : RETURN_WARN;
out:
    if (s >= 0) CloseSocket(s);
    if (SocketBase) CloseLibrary(SocketBase);
    if (fh) Close(fh);
    FreeArgs(rd);
    return rc;
}
