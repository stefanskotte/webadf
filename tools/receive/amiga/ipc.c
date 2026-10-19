/* See ipc.h. One message per file; the server holds it until the file is done. Ctrl-C in the waiting Shell sends LETGO:
   the server answers that Shell's messages at once, and the files stay in its list. */
#include <string.h>
#include <exec/memory.h>
#include <exec/ports.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include "ipc.h"

enum { RXM_FILE, RXM_TRUST, RXM_LETGO };
typedef struct rx_msg {
    struct Message m;
    int kind;
    char local[RX_LOCAL_MAX + 1], name[RX_PATH_MAX + 1];
    LONG ok; ULONG size; char text[80];
} rx_msg;

static struct MsgPort *port;
static struct { unsigned tag; rx_msg *m; } held[RX_UP_MAX];
static int nheld;

int ipc_running(void) { struct MsgPort *p; Forbid(); p = FindPort((STRPTR)RX_PORT_NAME); Permit(); return p != NULL; }
static int put_msg(rx_msg *m) {
    struct MsgPort *p;
    Forbid(); p = FindPort((STRPTR)RX_PORT_NAME); if (p) PutMsg(p, &m->m); Permit();
    return p ? 0 : -1;
}
static void init_msg(rx_msg *m, struct MsgPort *reply, int kind) {
    memset(m, 0, sizeof *m);
    m->m.mn_ReplyPort = reply; m->m.mn_Length = (UWORD)sizeof *m; m->kind = kind;
}

/* A Receive that died without removing its port (a crash, a Guru) never answers. After LETGO the wait is a poll: a
   second Ctrl-C, or ~5 s with no reply, gives up -- and leaks the messages and the reply port on purpose, since a
   Receive that is only slow might still reply into them. */
#define RX_LETGO_TICKS 250   /* 5 s at 50 ticks/s */
static int give_up(unsigned left) {
    LONG a[1];
    a[0] = (LONG)left;
    VPrintf((STRPTR)"Receive is not answering (its port webadf.Receive may be stale); %lu files not confirmed\n", a);
    Flush(Output());
    return 1;
}
int ipc_hand_off(const rx_upq *items, int trust, int *ok) {
    static rx_msg ctl, tm;
    struct MsgPort *reply = CreateMsgPort();
    rx_msg *m;
    unsigned i, sent = 0, got = 0;
    int letgo = 0, ctl_out = 0, tm_out = 0;
    ULONG waited = 0;
    LONG a[2];
    *ok = 0;
    if (!reply) return -1;
    m = AllocVec(sizeof(rx_msg) * (items->n ? items->n : 1), MEMF_PUBLIC | MEMF_CLEAR);
    if (!m) { DeleteMsgPort(reply); return -1; }
    /* TRUST first: messages to one port are taken in order, so the files that follow see the new key. */
    if (trust) { init_msg(&tm, reply, RXM_TRUST); if (put_msg(&tm) == 0) tm_out = 1; }
    for (i = 0; i < items->n; i++) {
        init_msg(&m[i], reply, RXM_FILE);
        strcpy(m[i].local, items->q[i].local); strcpy(m[i].name, items->q[i].name);
        if (put_msg(&m[i]) != 0) break;
        sent++;
    }
    for (i = sent; i < items->n; i++) { a[0] = (LONG)items->q[i].name; VPrintf((STRPTR)"%s  ERR Receive stopped\n", a); }
    while (got < sent || ctl_out || tm_out) {
        ULONG sig;
        struct Message *r;
        if (!letgo) sig = Wait(1UL << reply->mp_SigBit | SIGBREAKF_CTRL_C);
        else { Delay(10); waited += 10; sig = SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C; }
        if (sig & SIGBREAKF_CTRL_C) {
            if (letgo) return give_up(sent - got);   /* the second Ctrl-C */
            init_msg(&ctl, reply, RXM_LETGO);
            if (put_msg(&ctl) == 0) ctl_out = 1;
            letgo = 1;
            PutStr((STRPTR)"Stopped waiting; Receive keeps the files in its list\n");
        }
        while ((r = GetMsg(reply)) != NULL) {
            rx_msg *x = (rx_msg *)r;
            if (x == &ctl) { ctl_out = 0; continue; }
            if (x == &tm) { tm_out = 0; continue; }
            got++;
            a[0] = (LONG)x->name;
            if (x->ok) { a[1] = (LONG)x->size; VPrintf((STRPTR)"%s  %lu bytes  OK\n", a); (*ok)++; }
            else { a[1] = (LONG)x->text; VPrintf((STRPTR)"%s  ERR %s\n", a); }
            Flush(Output());
        }
        if (letgo && waited >= RX_LETGO_TICKS && (got < sent || ctl_out || tm_out)) return give_up(sent - got);
    }
    FreeVec(m);
    DeleteMsgPort(reply);
    return sent > 0 ? 0 : -1;
}

int ipc_open(void) {
    struct MsgPort *p;
    if (port) return 0;
    port = CreateMsgPort();
    if (!port) return -1;
    port->mp_Node.ln_Name = (char *)RX_PORT_NAME;
    port->mp_Node.ln_Pri = 0;
    Forbid(); p = FindPort((STRPTR)RX_PORT_NAME); if (!p) AddPort(port); Permit();
    if (p) { DeleteMsgPort(port); port = NULL; return -1; }   /* another Receive owns it */
    return 0;
}
ULONG ipc_sigmask(void) { return port ? 1UL << port->mp_SigBit : 0; }
static void answer(rx_msg *m, int ok, unsigned long size, const char *text) {
    m->ok = ok; m->size = size;
    strncpy(m->text, text ? text : "", sizeof m->text - 1); m->text[sizeof m->text - 1] = 0;
    ReplyMsg(&m->m);
}
void ipc_take(rx_upq *q, rx_added_fn added, int (*trust)(void *u), void *u) {
    rx_msg *m;
    int i;
    if (!port) return;
    while ((m = (rx_msg *)GetMsg(port)) != NULL) {
        if (m->kind == RXM_TRUST) { m->ok = trust && trust(u) == 0; ReplyMsg(&m->m); continue; }
        if (m->kind == RXM_LETGO) {
            for (i = nheld - 1; i >= 0; i--) if (held[i].m->m.mn_ReplyPort == m->m.mn_ReplyPort) {
                answer(held[i].m, 0, 0, "not waited for (still in Receive's list)");
                held[i] = held[--nheld];
            }
            ReplyMsg(&m->m);
            continue;
        }
        {
            unsigned tag = nheld < RX_UP_MAX ? rx_up_add(q, m->local, m->name) : 0;
            if (!tag) { answer(m, 0, 0, "Receive's list is full, or the name is not allowed"); continue; }
            held[nheld].tag = tag; held[nheld].m = m; nheld++;
            if (added) added(u, &q->q[q->n - 1]);
        }
    }
}
void ipc_done(unsigned tag, int ok, unsigned long size, const char *text) {
    int i;
    for (i = 0; i < nheld; i++) if (held[i].tag == tag) { answer(held[i].m, ok, size, text); held[i] = held[--nheld]; return; }
}
void ipc_close(void) {
    rx_msg *m;
    if (!port) return;
    Forbid(); RemPort(port); Permit();
    while (nheld > 0) { nheld--; answer(held[nheld].m, 0, 0, "Receive stopped"); }
    while ((m = (rx_msg *)GetMsg(port)) != NULL) answer(m, 0, 0, "Receive stopped");
    DeleteMsgPort(port);
    port = NULL;
}
