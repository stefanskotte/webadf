/* poke: FS-UAE test helper for Transfer 2.7 (never shipped). Drives the Amiga from its own startup-sequence, since
   keys typed on the Mac never reach FS-UAE's Amiga (measured 2026-11-01). One command per run, output on stdout:
     poke list                         the commodity brokers, one name per line (Exchange's own list)
     poke cx <broker> <appear|disappear|enable|disable|kill>   what Exchange's buttons send
     poke key <rawcode hex> <qualifier hex>                     a key down and up through the input stream
     poke win <title>                  "open" or "closed": a window with exactly that title
     poke gadget <title> <id>          clicks the centre of that window's gadget with that GadgetID (-1: close gadget)
     poke gadsel <title> <id>          "on"/"off" and ",disabled" for that gadget
     poke click <x> <y> <n>            n clicks (2: a double-click) at x,y of the frontmost screen
     poke wbclick <x> <y> <n>          the same at x,y inside Workbench's own window (an icon's position)
     poke waitfile <path> <secs>       returns once path exists (rc 5 on timeout)
   Commodities' private calls (LVOs from the NDK's commodities_lib.fd, ##private 2..4): CopyBrokerList -186,
   FreeBrokerList -192, BrokerCommand -198 -- the calls Exchange itself makes. */
#include <string.h>
#include <stdlib.h>
#include <exec/memory.h>
#include <exec/lists.h>
#include <devices/inputevent.h>
#include <intuition/intuition.h>
#include <intuition/intuitionbase.h>
#include <libraries/commodities.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/intuition.h>
#include <proto/commodities.h>

struct Library *CxBase = NULL;
struct IntuitionBase *IntuitionBase = NULL;

typedef struct { struct Node bc_Node; char bc_Name[CBD_NAMELEN]; char bc_Title[CBD_TITLELEN]; char bc_Descr[CBD_DESCRLEN];
                 LONG bc_Task; LONG bc_Port; UWORD bc_Dummy; ULONG bc_Flags; } BrokerCopy;

static LONG copy_brokers(struct List *l) {
    register LONG d0 __asm("d0");
    register struct List *a0 __asm("a0") = l;
    register struct Library *a6 __asm("a6") = CxBase;
    __asm volatile ("jsr a6@(-186:W)" : "=r"(d0), "+r"(a0) : "r"(a6) : "d1", "a1", "cc", "memory");
    return d0;
}
static void free_brokers(struct List *l) {
    register struct List *a0 __asm("a0") = l;
    register struct Library *a6 __asm("a6") = CxBase;
    __asm volatile ("jsr a6@(-192:W)" : "+r"(a0) : "r"(a6) : "d0", "d1", "a1", "cc", "memory");
}
static LONG broker_command(const char *name, LONG id) {
    register LONG d0 __asm("d0") = id;
    register const char *a0 __asm("a0") = name;
    register struct Library *a6 __asm("a6") = CxBase;
    __asm volatile ("jsr a6@(-198:W)" : "+r"(d0), "+r"(a0) : "r"(a6) : "d1", "a1", "cc", "memory");
    return d0;
}

static void say(const char *s) { PutStr((STRPTR)s); PutStr((STRPTR)"\n"); }
static struct Window *find_win(const char *title) {
    struct Screen *sc; struct Window *w, *hit = NULL;
    ULONG lock = LockIBase(0);
    for (sc = IntuitionBase->FirstScreen; sc && !hit; sc = sc->NextScreen)
        for (w = sc->FirstWindow; w; w = w->NextWindow) if (w->Title && !strcmp((char *)w->Title, title)) { hit = w; break; }
    UnlockIBase(lock);
    return hit;
}
static struct Gadget *find_gad(struct Window *w, long id) {
    struct Gadget *g;
    for (g = w->FirstGadget; g; g = g->NextGadget)
        if (id < 0 ? (g->GadgetType & GTYP_SYSGADGET) && (g->GadgetType & 0xF0) == GTYP_CLOSE
                   : g->GadgetID == id && !(g->GadgetType & GTYP_SYSGADGET)) return g;
    return NULL;
}
static void event(UWORD cls, UWORD code, UWORD qual, WORD x, WORD y) {
    struct InputEvent ie;
    memset(&ie, 0, sizeof ie);
    ie.ie_Class = (UBYTE)cls; ie.ie_Code = code; ie.ie_Qualifier = qual; ie.ie_X = x; ie.ie_Y = y;
    AddIEvents(&ie);
}
/* Closed loop on the screen's own idea of the pointer: mouse ticks, acceleration and resolution do not matter. */
static int move_to(struct Screen *sc, WORD x, WORD y) {
    int i;
    for (i = 0; i < 200; i++) {
        WORD dx = (WORD)(x - sc->MouseX), dy = (WORD)(y - sc->MouseY);
        if (!dx && !dy) return 0;
        event(IECLASS_RAWMOUSE, IECODE_NOBUTTON, IEQUALIFIER_RELATIVEMOUSE,
              (WORD)(dx > 1 || dx < -1 ? dx / 2 : dx), (WORD)(dy > 1 || dy < -1 ? dy / 2 : dy));
        Delay(1);
    }
    return -1;
}
static int click_at(struct Screen *sc, WORD x, WORD y, int n) {
    int i;
    if (move_to(sc, x, y) != 0) { say("could not place the pointer"); return 10; }
    for (i = 0; i < n; i++) {
        event(IECLASS_RAWMOUSE, IECODE_LBUTTON, IEQUALIFIER_RELATIVEMOUSE | IEQUALIFIER_LEFTBUTTON, 0, 0); Delay(2);
        event(IECLASS_RAWMOUSE, IECODE_LBUTTON | IECODE_UP_PREFIX, IEQUALIFIER_RELATIVEMOUSE, 0, 0); Delay(5);
    }
    return 0;
}

int main(int argc, char **argv) {
    int rc = 0;
    if (argc < 2) return 20;
    IntuitionBase = (struct IntuitionBase *)OpenLibrary((STRPTR)"intuition.library", 37);
    CxBase = OpenLibrary((STRPTR)"commodities.library", 37);
    if (!IntuitionBase || !CxBase) { say("no intuition or commodities"); return 20; }
    if (!strcmp(argv[1], "list")) {
        struct List l; struct Node *n;
        l.lh_Head = (struct Node *)&l.lh_Tail; l.lh_Tail = NULL; l.lh_TailPred = (struct Node *)&l.lh_Head;
        copy_brokers(&l);
        for (n = l.lh_Head; n->ln_Succ; n = n->ln_Succ) say(((BrokerCopy *)n)->bc_Name);
        free_brokers(&l);
    } else if (!strcmp(argv[1], "cx") && argc == 4) {
        LONG id = !strcmp(argv[3], "appear") ? CXCMD_APPEAR : !strcmp(argv[3], "disappear") ? CXCMD_DISAPPEAR :
                  !strcmp(argv[3], "enable") ? CXCMD_ENABLE : !strcmp(argv[3], "disable") ? CXCMD_DISABLE : CXCMD_KILL;
        rc = broker_command(argv[2], id) == 0 ? 0 : 10;
        say(rc ? "no such broker" : "sent");
    } else if (!strcmp(argv[1], "key") && argc == 4) {
        UWORD code = (UWORD)strtol(argv[2], NULL, 16), q = (UWORD)strtol(argv[3], NULL, 16);
        event(IECLASS_RAWKEY, code, q, 0, 0); Delay(2);
        event(IECLASS_RAWKEY, (UWORD)(code | IECODE_UP_PREFIX), q, 0, 0);
    } else if (!strcmp(argv[1], "win") && argc == 3) {
        say(find_win(argv[2]) ? "open" : "closed");
    } else if ((!strcmp(argv[1], "gadget") || !strcmp(argv[1], "gadsel")) && argc == 4) {
        struct Window *w = find_win(argv[2]); struct Gadget *g = w ? find_gad(w, strtol(argv[3], NULL, 10)) : NULL;
        if (!g) { say("no such gadget"); rc = 10; }
        else if (argv[1][3] == 's') { PutStr((STRPTR)((g->Flags & GFLG_SELECTED) ? "on" : "off")); say((g->Flags & GFLG_DISABLED) ? ",disabled" : ""); }
        else rc = click_at(w->WScreen, (WORD)(w->LeftEdge + g->LeftEdge + g->Width / 2), (WORD)(w->TopEdge + g->TopEdge + g->Height / 2), 1);
    } else if (!strcmp(argv[1], "click") && argc == 5) {
        rc = click_at(IntuitionBase->FirstScreen, (WORD)atoi(argv[2]), (WORD)atoi(argv[3]), atoi(argv[4]));
    } else if (!strcmp(argv[1], "wbclick") && argc == 5) {
        struct Screen *sc; struct Window *w = NULL;
        ULONG lock = LockIBase(0);
        for (sc = IntuitionBase->FirstScreen; sc && !w; sc = sc->NextScreen)
            for (w = sc->FirstWindow; w && !(w->Flags & WFLG_WBENCHWINDOW); w = w->NextWindow) ;
        UnlockIBase(lock);
        if (!w) { say("no Workbench window"); rc = 10; }
        else rc = click_at(w->WScreen, (WORD)(w->LeftEdge + w->BorderLeft + atoi(argv[2])),
                           (WORD)(w->TopEdge + w->BorderTop + atoi(argv[3])), atoi(argv[4]));
    } else if (!strcmp(argv[1], "waitfile") && argc == 4) {
        long t = atol(argv[3]) * 10; BPTR l = 0;
        while (t-- > 0 && !(l = Lock((STRPTR)argv[2], ACCESS_READ))) Delay(5);
        if (l) UnLock(l); else rc = 5;
    } else rc = 20;
    CloseLibrary(CxBase); CloseLibrary((struct Library *)IntuitionBase);
    return rc;
}
