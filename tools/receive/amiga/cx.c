/* See cx.h. commodities.library and icon.library V37 (Kickstart 2.04), both opened only when used: the Shell form
   never opens them (512 KB Amigas). */
#include <string.h>
#include <exec/memory.h>
#include <libraries/commodities.h>
#include <workbench/workbench.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/commodities.h>
#include <proto/icon.h>
#include "cx.h"

/* Defined (= NULL), not tentative, as gui.c's: libnix would otherwise open them at startup in every mode. */
struct Library *CxBase = NULL, *IconBase = NULL;
static struct MsgPort *cxport;
static CxObj *broker;
static int hotkey_bad;
#define CX_ID_POP 1

void cx_defaults(cx_opts *o) {
    memset(o, 0, sizeof *o);
    o->popup = 1;
    strcpy(o->popkey, "ctrl alt w");
}

void cx_tooltypes(const struct WBArg *self, cx_opts *o, char *dir, unsigned cap) {
    struct DiskObject *d;
    BPTR old;
    char *v;
    if (!self || !self->wa_Name || !(IconBase = OpenLibrary((STRPTR)"icon.library", 37))) return;
    old = CurrentDir(self->wa_Lock);
    d = GetDiskObject(self->wa_Name);
    CurrentDir(old);
    if (d) {
        STRPTR *tt = (STRPTR *)d->do_ToolTypes;
        LONG n;
        if (tt) {
            if ((v = (char *)FindToolType(tt, (STRPTR)"CX_POPUP")) != NULL) o->popup = !MatchToolValue((STRPTR)v, (STRPTR)"NO");
            if ((v = (char *)FindToolType(tt, (STRPTR)"CX_POPKEY")) != NULL) { strncpy(o->popkey, v, sizeof o->popkey - 1); o->popkey[sizeof o->popkey - 1] = 0; }
            if ((v = (char *)FindToolType(tt, (STRPTR)"CX_PRIORITY")) != NULL && StrToLong((STRPTR)v, &n) > 0)
                o->pri = n < -128 ? -128 : n > 127 ? 127 : n;
            if ((v = (char *)FindToolType(tt, (STRPTR)"TO")) != NULL && v[0]) { strncpy(dir, v, cap - 1); dir[cap - 1] = 0; }
        }
        FreeDiskObject(d);
    }
    CloseLibrary(IconBase);
    IconBase = NULL;
}

int cx_open(const cx_opts *o) {
    struct NewBroker nb;
    LONG err = 0;
    CxObj *f;
    if (!(CxBase = OpenLibrary((STRPTR)"commodities.library", 37))) return -1;
    if (!(cxport = CreateMsgPort())) { cx_close(); return -1; }
    memset(&nb, 0, sizeof nb);
    nb.nb_Version = NB_VERSION;
    nb.nb_Name = (STRPTR)"Transfer";
    nb.nb_Title = (STRPTR)"Transfer: web app <-> Amiga";
    nb.nb_Descr = (STRPTR)"Files to and from the web app";
    nb.nb_Unique = NBU_UNIQUE | NBU_NOTIFY;   /* a second start tells this one (CXCMD_UNIQUE) and gets CBERR_DUP */
    nb.nb_Flags = COF_SHOW_HIDE;
    nb.nb_Pri = (BYTE)o->pri;
    nb.nb_Port = cxport;
    broker = CxBroker(&nb, &err);
    if (!broker) { cx_close(); return err == CBERR_DUP ? 1 : -1; }
    if (o->popkey[0] && (f = CxFilter(o->popkey)) != NULL) {
        AttachCxObj(broker, f);
        AttachCxObj(f, CxSender(cxport, CX_ID_POP));
        AttachCxObj(f, CxTranslate(NULL));   /* the key goes no further */
        if (CxObjError(f)) { RemoveCxObj(f); DeleteCxObjAll(f); hotkey_bad = 1; }
    }
    ActivateCxObj(broker, 1);
    return 0;
}
int cx_hotkey_bad(void) { return hotkey_bad; }
ULONG cx_sigmask(void) { return cxport ? 1UL << cxport->mp_SigBit : 0; }

int cx_take(void) {
    struct Message *m;
    int r = 0;
    if (!cxport) return 0;
    while ((m = GetMsg(cxport)) != NULL) {
        ULONG type = CxMsgType((CxMsg *)m);
        LONG id = CxMsgID((CxMsg *)m);
        ReplyMsg(m);
        if (type == CXM_IEVENT && id == CX_ID_POP) r |= CX_SHOW;
        else if (type == CXM_COMMAND) switch (id) {
            case CXCMD_DISABLE: ActivateCxObj(broker, 0); r = (r & ~CX_ENABLE) | CX_DISABLE; break;
            case CXCMD_ENABLE: ActivateCxObj(broker, 1); r = (r & ~CX_DISABLE) | CX_ENABLE; break;
            case CXCMD_APPEAR: case CXCMD_UNIQUE: r = (r & ~CX_HIDE) | CX_SHOW; break;
            case CXCMD_DISAPPEAR: r = (r & ~CX_SHOW) | CX_HIDE; break;
            case CXCMD_KILL: r |= CX_QUIT; break;
            default: break;
        }
    }
    return r;
}

void cx_close(void) {
    struct Message *m;
    if (broker) { DeleteCxObjAll(broker); broker = NULL; }
    if (cxport) { while ((m = GetMsg(cxport)) != NULL) ReplyMsg(m); DeleteMsgPort(cxport); cxport = NULL; }
    if (CxBase) { CloseLibrary(CxBase); CxBase = NULL; }
}
