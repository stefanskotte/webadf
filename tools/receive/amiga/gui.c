/* Transfer's window (spec 2026-10-16 §5, 2026-10-18 §2): the folder, the board, and both directions in one list. It is
   an AppWindow: icons dropped on it go to the web app (a drawer walked, 64 files at most); Send... opens an asl
   requester (several files on V38+, one on V37). gadtools, asl and workbench only (V37). */
#include <stdio.h>
#include <string.h>
#include <exec/memory.h>
#include <intuition/intuition.h>
#include <libraries/gadtools.h>
#include <libraries/asl.h>
#include <workbench/workbench.h>
#include <workbench/startup.h>
#include <proto/exec.h>
#include <proto/intuition.h>
#include <proto/gadtools.h>
#include <proto/graphics.h>
#include <proto/asl.h>
#include <proto/dos.h>
#include <proto/wb.h>
#include "afs.h"
#include "clock.h"
#include "config.h"
#include "ipc.h"
#include "net.h"
#include "ui.h"

struct Library *GadToolsBase, *AslBase, *WorkbenchBase;
struct IntuitionBase *IntuitionBase;
struct GfxBase *GfxBase;

enum { G_DIR, G_CHOOSE, G_SEND, G_RETRY, G_TRUST, G_SAVE, G_STATUS, G_LIST, G_N };
#define ROWS_MAX 96
enum { ST_WAITING, ST_RECEIVING, ST_DONE, ST_FAILED, ST_UP_WAITING, ST_UP_MOVING, ST_UP_DONE, ST_UP_FAILED };
typedef struct { struct Node node; char id[RX_ID_MAX + 1]; unsigned tag; char name[RX_PATH_MAX + 1];
                 char local[RX_LOCAL_MAX + 1]; unsigned long size; int state; unsigned pct; char why[40]; char text[80]; } row;

typedef struct {
    struct Window *win; struct Gadget *g[G_N]; APTR vi; struct Screen *scr;
    struct List list; row rows[ROWS_MAX]; int n;
    afs_ctx *ctx; rx_fs *fs; rx_session *s; rx_upq *q;
    struct MsgPort *app_port; struct AppWindow *app_win;
    char status[80]; char pending[256]; int has_pending; int quit; int connected;
    char okstatus[80]; int stalled; ULONG t_wait;   /* spec §8: "waiting for the web app" while the credit is stalled */
    int old_board;   /* the board connected cannot take files up (before 1.19.0) */
    struct Gadget *gl;   /* CreateContext's list: freed after CloseWindow (FirstGadget includes system gadgets) */
} gui;

/* amiga.lib's NewList, without linking amiga.lib. */
static void new_list(struct List *l) { l->lh_Head = (struct Node *)&l->lh_Tail; l->lh_Tail = NULL; l->lh_TailPred = (struct Node *)&l->lh_Head; }

static void set_status(gui *G, const char *t) {
    strncpy(G->status, t, sizeof G->status - 1);
    if (G->win) GT_SetGadgetAttrs(G->g[G_STATUS], G->win, NULL, GTTX_Text, (ULONG)G->status, TAG_END);
}
static void set_trust_button(gui *G, int on) {
    if (G->win) GT_SetGadgetAttrs(G->g[G_TRUST], G->win, NULL, GA_Disabled, (ULONG)(on ? FALSE : TRUE), TAG_END);
}
/* Every board before 1.19.0 connects this way to send files down: said only once something is to go up (as shell.c). */
#define OLD_FW "This board's firmware cannot receive files (update to 1.19.0)"
static unsigned pct_of(unsigned long bytes, unsigned long size) {
    unsigned p = size ? (unsigned)(bytes / (size / 100 + 1)) : 0;
    return p > 99 ? 99 : p;
}
static void row_text(row *r) {
    char nm[18], sz[16]; const char *base = strrchr(r->name, '/'); size_t l;
    base = base ? base + 1 : r->name;
    strncpy(nm, base, 17); nm[17] = 0;
    l = strlen(nm); while (l < 17) nm[l++] = ' '; nm[17] = 0;
    /* A file waiting to go up has no size yet (the board's TAKE brings it): blank, not "0 KB". */
    if (!r->size && (r->state == ST_UP_WAITING || r->state == ST_UP_FAILED)) strcpy(sz, "       ");
    /* Files are 4 MB at most (4 digits of KB); a LIST from anyone on the LAN may say more: MB then (4 GB = 4096 MB). */
    else if (r->size <= 9999UL * 1024) sprintf(sz, "%4lu KB", (r->size + 1023) / 1024);
    else sprintf(sz, "%4lu MB", r->size / 1048576UL + 1);
    switch (r->state) {
    case ST_WAITING: sprintf(r->text, "%s %s waiting", nm, sz); break;
    case ST_RECEIVING: sprintf(r->text, "%s %s receiving %u%%", nm, sz, r->pct); break;
    case ST_DONE: sprintf(r->text, "%s %s done", nm, sz); break;
    case ST_FAILED: sprintf(r->text, "%s %s failed: %.30s", nm, sz, r->why); break;
    case ST_UP_WAITING: sprintf(r->text, "%s %s to web: waiting", nm, sz); break;
    case ST_UP_MOVING: sprintf(r->text, "%s %s to web: %u %%", nm, sz, r->pct); break;
    case ST_UP_DONE: sprintf(r->text, "%s %s to web: done", nm, sz); break;
    default: sprintf(r->text, "%s %s to web: failed: %.24s", nm, sz, r->why); break;
    }
    r->node.ln_Name = r->text;
}
static void relist(gui *G) {
    int i;
    if (G->win) GT_SetGadgetAttrs(G->g[G_LIST], G->win, NULL, GTLV_Labels, ~0UL, TAG_END);
    new_list(&G->list);
    for (i = 0; i < G->n; i++) { row_text(&G->rows[i]); AddTail(&G->list, &G->rows[i].node); }
    if (G->win) GT_SetGadgetAttrs(G->g[G_LIST], G->win, NULL, GTLV_Labels, (ULONG)&G->list, TAG_END);
}
static int active(const row *r) {
    return r->state == ST_WAITING || r->state == ST_RECEIVING || r->state == ST_UP_WAITING || r->state == ST_UP_MOVING;
}
static row *find(gui *G, const char *id) { int i; for (i = 0; i < G->n; i++) if (G->rows[i].id[0] && !strcmp(G->rows[i].id, id)) return &G->rows[i]; return NULL; }
static row *find_tag(gui *G, unsigned tag) { int i; for (i = 0; i < G->n; i++) if (G->rows[i].tag == tag) return &G->rows[i]; return NULL; }
static void drop_at(gui *G, int i) { memmove(&G->rows[i], &G->rows[i + 1], (size_t)(G->n - i - 1) * sizeof(row)); G->n--; }
static row *add(gui *G, const char *id) {
    int i;
    if (G->n == ROWS_MAX) {
        for (i = 0; i < G->n && active(&G->rows[i]); i++) ;
        if (i == G->n) return NULL;
        drop_at(G, i);
    }
    memset(&G->rows[G->n], 0, sizeof(row));
    strcpy(G->rows[G->n].id, id);
    return &G->rows[G->n++];
}

/* --- files going up --- */
static void on_added(void *u, const rx_up_item *it) {
    gui *G = u; row *r = add(G, "");
    if (!r) return;
    r->tag = it->tag; strcpy(r->name, it->name); strcpy(r->local, it->local); r->state = ST_UP_WAITING;
}
static void add_path(gui *G, const char *path) {
    char name[RX_PART_MAX + 1];
    afs_base_name(path, name);
    if (rx_up_add_tree(G->q, G->fs, path, name, on_added, G) <= 0) {
        row *r = add(G, "");
        if (r) { strcpy(r->name, name); strncpy(r->local, path, RX_LOCAL_MAX); r->state = ST_UP_FAILED; strcpy(r->why, "cannot read it"); }
    }
    relist(G);
    if (!G->connected && G->q->n) set_status(G, "Waiting for the board");
}
static void add_wbarg(gui *G, const struct WBArg *a) {
    char p[RX_LOCAL_MAX + 1];
    if (!a->wa_Lock || !NameFromLock(a->wa_Lock, (STRPTR)p, sizeof p)) return;
    if (a->wa_Name && a->wa_Name[0] && !AddPart((STRPTR)p, a->wa_Name, sizeof p)) return;
    add_path(G, p);
}
static void send_files(gui *G) {
    int multi = AslBase->lib_Version >= 38;
    struct FileRequester *fr = AllocAslRequestTags(ASL_FileRequest,
        ASLFR_Window, (ULONG)G->win, ASLFR_TitleText, (ULONG)"Send to the web app",
        multi ? ASLFR_DoMultiSelect : TAG_IGNORE, TRUE, TAG_END);
    char p[RX_LOCAL_MAX + 1];
    LONG i;
    if (!fr) return;
    if (AslRequest(fr, NULL)) {
        if (multi && fr->fr_NumArgs > 0) {
            for (i = 0; i < fr->fr_NumArgs; i++) {
                strncpy(p, (const char *)fr->fr_Drawer, sizeof p - 1); p[sizeof p - 1] = 0;
                if (AddPart((STRPTR)p, fr->fr_ArgList[i].wa_Name, sizeof p)) add_path(G, p);
            }
        } else if (fr->fr_File && fr->fr_File[0]) {
            strncpy(p, (const char *)fr->fr_Drawer, sizeof p - 1); p[sizeof p - 1] = 0;
            if (AddPart((STRPTR)p, fr->fr_File, sizeof p)) add_path(G, p);
        }
    }
    FreeAslRequest(fr);
}
/* Retry (spec §8): every failed upload goes again with a new PUT; the web app resumes what it already has. */
static void retry_failed(gui *G) {
    int i;
    for (i = 0; i < G->n; i++) {
        row *r = &G->rows[i];
        unsigned tag;
        if (r->state != ST_UP_FAILED || !r->local[0]) continue;
        tag = rx_up_add(G->q, r->local, r->name);
        if (tag) { r->tag = tag; r->state = ST_UP_WAITING; r->pct = 0; r->why[0] = 0; }
    }
    relist(G);
}
/* TRUST from `Transfer SEND TRUST ...` in a Shell, as shell.c: with no board yet, the next board's key is trusted. */
static int gui_trust(void *u) { gui *G = u; if (rx_trust_now(G->s) != 0) G->q->trust_next = 1; return 0; }

static void on_event(void *u, const rx_event *e, rx_session *s) {
    gui *G = u; row *r; unsigned i; int k;
    char k4[5], t[80];
    switch (e->kind) {
    case RX_EV_LIST:
        for (k = G->n - 1; k >= 0; k--) {
            int listed = 0;
            for (i = 0; i < s->list_n; i++) if (!strcmp(s->list[i].id, G->rows[k].id)) listed = 1;
            if (G->rows[k].state == ST_WAITING && !listed) drop_at(G, k);
        }
        for (i = 0; i < s->list_n; i++) if (!find(G, s->list[i].id) && (r = add(G, s->list[i].id)) != NULL) {
            strcpy(r->name, s->list[i].path); r->size = s->list[i].size; r->state = ST_WAITING;
        }
        break;
    case RX_EV_BEGIN:
        if (!(r = find(G, e->id))) r = add(G, e->id);
        if (r) { strcpy(r->name, e->path); r->size = e->size; r->state = ST_RECEIVING; r->pct = 0; }
        break;
    case RX_EV_PROGRESS:
        if ((r = find(G, e->id)) != NULL) r->pct = pct_of(e->bytes, e->size);
        break;
    case RX_EV_DONE:
        if ((r = find(G, e->id)) != NULL) { strcpy(r->name, e->path); r->state = ST_DONE; }
        if (G->has_pending) { afs_set_root(G->ctx, G->pending); G->has_pending = 0; }
        break;
    case RX_EV_FAILED:
        if ((r = find(G, e->id)) != NULL) { r->state = ST_FAILED; strncpy(r->why, e->text ? e->text : "", sizeof r->why - 1); }
        if (G->has_pending) { afs_set_root(G->ctx, G->pending); G->has_pending = 0; }
        break;
    case RX_EV_TRUST:
        rx_key4(e->key, k4);
        if (!strcmp(e->code, "new")) {
            sprintf(t, cfg_key_save(e->key) == 0 ? "Trusted board %s" : "Trusted board %s (not saved: ENVARC:)", k4);
            set_status(G, t); strcpy(G->okstatus, t); set_trust_button(G, 0);
        } else if (!strcmp(e->code, "ok")) {
            sprintf(t, "Board connected (key %s)", k4); set_status(G, t); strcpy(G->okstatus, t); set_trust_button(G, 0);
        }
        else if (!strcmp(e->code, "other")) { set_status(G, "Another board or computer connected -- not sending"); set_trust_button(G, 1); }
        else { G->old_board = 1; if (G->q->n) set_status(G, OLD_FW); set_trust_button(G, 0); }
        return;
    case RX_EV_UP_BEGIN:
        if (!(r = find_tag(G, e->tag)) && (r = add(G, "")) != NULL) { r->tag = e->tag; strcpy(r->name, e->path); }
        if (r) { r->size = e->size; r->state = ST_UP_MOVING; r->pct = pct_of(e->bytes, e->size); }
        break;
    case RX_EV_UP_PROGRESS:
        if ((r = find_tag(G, e->tag)) != NULL) r->pct = pct_of(e->bytes, e->size);
        break;
    case RX_EV_UP_DONE:
        if ((r = find_tag(G, e->tag)) != NULL) { r->state = ST_UP_DONE; r->size = e->size; }
        ipc_done(e->tag, 1, e->size, "");
        break;
    case RX_EV_UP_FAILED:
        if ((r = find_tag(G, e->tag)) != NULL) { r->state = ST_UP_FAILED; strncpy(r->why, e->text ? e->text : "", sizeof r->why - 1); }
        ipc_done(e->tag, 0, 0, e->text);
        break;
    default: return;
    }
    relist(G);
}
/* net_run reports "Listening on port 6800"; a missing folder says so instead, from the first draw. */
static void on_status(void *u, const char *t) { gui *G = u; set_status(G, G->fs->folder_ok(G->ctx) ? t : "Folder not found"); }
static void on_link(void *u, int connected) {
    gui *G = u;
    G->connected = connected;
    G->stalled = 0; G->t_wait = 0; G->old_board = 0;
    if (!connected) { set_trust_button(G, 0); set_status(G, G->q->n ? "Waiting for the board" : "Listening on port 6800"); }
}
/* Spec §8: while the board holds the credit (or the last answer) for over 15 s, the web app is what the file waits for. */
static int gui_pass(void *u, rx_session *s, int connected) {
    gui *G = u;
    int waiting = connected && (s->up_phase == RX_UP_ENDED || (s->up_phase == RX_UP_DATA && s->up_sent >= s->up_credit));
    if (!waiting) {
        G->t_wait = 0;
        if (G->stalled) { G->stalled = 0; set_status(G, G->okstatus); }
        return 0;
    }
    if (!G->t_wait) G->t_wait = rx_now_secs();
    else if (!G->stalled && rx_now_secs() - G->t_wait > 15) { G->stalled = 1; set_status(G, "Waiting for the web app"); }
    return 0;
}
static const char *dir_text(gui *G) { return (const char *)((struct StringInfo *)G->g[G_DIR]->SpecialInfo)->Buffer; }
static void choose(gui *G) {
    struct FileRequester *fr = AllocAslRequestTags(ASL_FileRequest,
        ASLFR_Window, (ULONG)G->win, ASLFR_TitleText, (ULONG)"Save files to",
        ASLFR_InitialDrawer, (ULONG)dir_text(G), ASLFR_DrawersOnly, TRUE, TAG_END);
    if (!fr) return;
    if (AslRequest(fr, NULL))
        GT_SetGadgetAttrs(G->g[G_DIR], G->win, NULL, GTST_String, (ULONG)fr->fr_Drawer, TAG_END);
    FreeAslRequest(fr);
}
static void save(gui *G) {
    int saved;
    strncpy(G->pending, dir_text(G), sizeof G->pending - 1);
    /* Applied for this session even when ENVARC: is read-only (a write-protected boot floppy). */
    if (G->s && rx_busy(G->s)) G->has_pending = 1; else afs_set_root(G->ctx, G->pending);
    saved = cfg_save(G->pending) == 0;
    if (G->has_pending) set_status(G, saved ? "Saved; used after this file" : "Not saved (ENVARC:); used after this file");
    else if (!G->fs->folder_ok(G->ctx)) set_status(G, "Folder not found");
    else set_status(G, saved ? "Saved. Listening on port 6800" : "Not saved (ENVARC:). Listening on port 6800");
}
static int on_signal(void *u, ULONG sigs) {
    gui *G = u; struct IntuiMessage *m; struct AppMessage *am; LONG i;
    (void)sigs;
    while ((m = GT_GetIMsg(G->win->UserPort)) != NULL) {
        ULONG cls = m->Class; struct Gadget *gad = (struct Gadget *)m->IAddress;
        GT_ReplyIMsg(m);
        if (cls == IDCMP_CLOSEWINDOW) G->quit = 1;
        else if (cls == IDCMP_REFRESHWINDOW) { GT_BeginRefresh(G->win); GT_EndRefresh(G->win, TRUE); }
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_CHOOSE) choose(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_SAVE) save(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_SEND) send_files(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_RETRY) retry_failed(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_TRUST && rx_trust_now(G->s) != 0) set_status(G, "No board to trust yet");
    }
    if (G->app_port) while ((am = (struct AppMessage *)GetMsg(G->app_port)) != NULL) {
        for (i = 0; i < am->am_NumArgs; i++) add_wbarg(G, &am->am_ArgList[i]);
        ReplyMsg((struct Message *)am);
    }
    ipc_take(G->q, on_added, gui_trust, G);
    relist(G);
    /* A drop, Send... or a Shell's SEND while a board before 1.19.0 is connected: say why nothing moves. */
    if (G->connected && G->old_board && G->q->n) set_status(G, OLD_FW);
    return G->quit;
}

static UWORD text_w(struct RastPort *rp, const char *s) { return (UWORD)(TextLength(rp, (STRPTR)s, (UWORD)strlen(s)) + 16); }

static int build(gui *G, const char *dir) {
    struct NewGadget ng; struct Gadget *gl = NULL, *g;
    struct TextAttr *ta = G->scr->Font;
    struct TextFont *tf = OpenFont(ta);
    struct RastPort rp;
    UWORD fh = ta->ta_YSize, mw, lw, w, wsend, wretry, wtrust, x0, y, gh, iw, row2;
    InitRastPort(&rp);
    if (tf) SetFont(&rp, tf);
    mw = (UWORD)TextLength(&rp, (STRPTR)"M", 1);
    lw = (UWORD)TextLength(&rp, (STRPTR)"Save files to:", 14) + 8;
    w = text_w(&rp, "Choose...");
    wsend = text_w(&rp, "Send..."); wretry = text_w(&rp, "Retry failed"); wtrust = text_w(&rp, "Trust this board");
    if (tf) CloseFont(tf);
    iw = (UWORD)(77 * mw);   /* room for "to web: failed: connection lost" in the list; 616 px with topaz 8 */
    row2 = (UWORD)(wsend + wretry + wtrust + w + 3 * 6 + 12);   /* the second row's buttons, side by side */
    if (iw < row2) iw = row2;
    if (iw > G->scr->Width - 24) iw = (UWORD)(G->scr->Width - 24);
    x0 = (UWORD)(G->scr->WBorLeft + 6); y = (UWORD)(G->scr->WBorTop + fh + 1 + 4); gh = (UWORD)(fh + 6);
    g = CreateContext(&gl);
    memset(&ng, 0, sizeof ng);
    ng.ng_VisualInfo = G->vi; ng.ng_TextAttr = ta;
    ng.ng_LeftEdge = (WORD)(x0 + lw); ng.ng_TopEdge = (WORD)y; ng.ng_Width = (WORD)(iw - lw - w - 18); ng.ng_Height = (WORD)gh;
    ng.ng_GadgetText = (UBYTE *)"Save files to:"; ng.ng_GadgetID = G_DIR; ng.ng_Flags = PLACETEXT_LEFT;
    G->g[G_DIR] = g = CreateGadget(STRING_KIND, g, &ng, GTST_String, (ULONG)dir, GTST_MaxChars, 255, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + iw - w - 6); ng.ng_Width = (WORD)w; ng.ng_GadgetText = (UBYTE *)"Choose...";
    ng.ng_GadgetID = G_CHOOSE; ng.ng_Flags = PLACETEXT_IN;
    G->g[G_CHOOSE] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    y = (UWORD)(y + gh + 4);
    ng.ng_TopEdge = (WORD)y;
    ng.ng_LeftEdge = (WORD)x0; ng.ng_Width = (WORD)wsend; ng.ng_GadgetText = (UBYTE *)"Send..."; ng.ng_GadgetID = G_SEND;
    G->g[G_SEND] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + wsend + 6); ng.ng_Width = (WORD)wretry; ng.ng_GadgetText = (UBYTE *)"Retry failed"; ng.ng_GadgetID = G_RETRY;
    G->g[G_RETRY] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + wsend + wretry + 12); ng.ng_Width = (WORD)wtrust; ng.ng_GadgetText = (UBYTE *)"Trust this board"; ng.ng_GadgetID = G_TRUST;
    G->g[G_TRUST] = g = CreateGadget(BUTTON_KIND, g, &ng, GA_Disabled, TRUE, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + iw - w - 6); ng.ng_Width = (WORD)w; ng.ng_GadgetText = (UBYTE *)"Save"; ng.ng_GadgetID = G_SAVE;
    G->g[G_SAVE] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    y = (UWORD)(y + gh + 4);
    ng.ng_LeftEdge = (WORD)x0; ng.ng_TopEdge = (WORD)y; ng.ng_Width = (WORD)(iw - 12); ng.ng_GadgetText = NULL; ng.ng_GadgetID = G_STATUS;
    G->g[G_STATUS] = g = CreateGadget(TEXT_KIND, g, &ng, GTTX_Text, (ULONG)G->status, GTTX_Border, TRUE, TAG_END);
    y = (UWORD)(y + gh + 4);
    ng.ng_TopEdge = (WORD)y; ng.ng_Height = (WORD)(8 * (fh + 1) + 4); ng.ng_GadgetID = G_LIST;
    G->g[G_LIST] = g = CreateGadget(LISTVIEW_KIND, g, &ng, GTLV_Labels, (ULONG)&G->list, GTLV_ReadOnly, TRUE, TAG_END);
    G->gl = gl;
    if (!g) { FreeGadgets(gl); G->gl = NULL; return -1; }
    G->win = OpenWindowTags(NULL,
        WA_Title, (ULONG)"WebFloppy - Receive & Send", WA_PubScreen, (ULONG)G->scr, WA_Gadgets, (ULONG)gl,
        WA_InnerWidth, iw, WA_InnerHeight, (ULONG)(y + ng.ng_Height + 6 - (G->scr->WBorTop + fh + 1)),
        WA_DragBar, TRUE, WA_DepthGadget, TRUE, WA_CloseGadget, TRUE, WA_Activate, TRUE, WA_SimpleRefresh, TRUE,
        WA_IDCMP, IDCMP_CLOSEWINDOW | IDCMP_REFRESHWINDOW | BUTTONIDCMP | STRINGIDCMP | LISTVIEWIDCMP, TAG_END);
    if (!G->win) { FreeGadgets(gl); G->gl = NULL; return -1; }
    GT_RefreshWindow(G->win, NULL);
    return 0;
}

/* Without a network (no stack, or port 6800 taken) the window still takes drops, Send... and Shell hand-offs. */
static void wait_window(gui *G) {
    ULONG mask = 1UL << G->win->UserPort->mp_SigBit | (G->app_port ? 1UL << G->app_port->mp_SigBit : 0) | ipc_sigmask();
    while (!G->quit) {
        ULONG sigs = Wait(mask | SIGBREAKF_CTRL_C);
        if (sigs & SIGBREAKF_CTRL_C) break;
        on_signal(G, sigs);
    }
}

int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send, int trust) {
    static gui G; static afs_ctx ctx; static rx_fs fs; static rx_session s; static rx_upq q;
    char key[RX_KEY_HEX + 8];
    long i;
    int rc = RETURN_FAIL;
    IntuitionBase = (struct IntuitionBase *)OpenLibrary((STRPTR)"intuition.library", 37);
    GfxBase = (struct GfxBase *)OpenLibrary((STRPTR)"graphics.library", 37);
    GadToolsBase = OpenLibrary((STRPTR)"gadtools.library", 37);
    AslBase = OpenLibrary((STRPTR)"asl.library", 37);
    WorkbenchBase = OpenLibrary((STRPTR)"workbench.library", 37);   /* none (no Workbench): no drops, the rest works */
    if (!IntuitionBase || !GfxBase || !GadToolsBase || !AslBase) goto out;
    memset(&G, 0, sizeof G); new_list(&G.list);
    G.ctx = &ctx; G.fs = &fs; G.s = &s; G.q = &q;
    afs_init(&ctx, &fs, dir);
    cfg_key_load(key, sizeof key);
    rx_upq_init(&q, key);
    if (trust) gui_trust(&G);   /* Transfer GUI TRUST (ruling PF18): as the Shell form, the next board's key is trusted */
    strcpy(G.status, "Starting...");
    strcpy(G.okstatus, "Listening on port 6800");
    if (!(G.scr = LockPubScreen(NULL)) || !(G.vi = GetVisualInfo(G.scr, TAG_END))) goto out;
    if (build(&G, dir) != 0) goto out;
    if (WorkbenchBase && (G.app_port = CreateMsgPort()) != NULL)
        G.app_win = AddAppWindowA(0, 0, G.win, G.app_port, NULL);
    ipc_open();
    for (i = 0; i < nwb; i++) add_wbarg(&G, &wbargs[i]);           /* shift-clicked project icons */
    for (i = 0; send && send[i]; i++) add_path(&G, (const char *)send[i]);   /* Transfer GUI SEND ... */
    if (net_open() != 0) {
        set_status(&G, "No TCP/IP stack running (bsdsocket.library)");
        wait_window(&G);
    } else {
        net_ui ui;
        ui.u = &G; ui.on_event = on_event; ui.on_status = on_status;
        ui.extra_sigs = 1UL << G.win->UserPort->mp_SigBit | (G.app_port ? 1UL << G.app_port->mp_SigBit : 0) | ipc_sigmask();
        ui.on_signal = on_signal; ui.on_pass = gui_pass; ui.on_link = on_link;
        if (net_run(&ui, &ctx, &fs, &s, &q) != 0) {
            /* e.g. Transfer is already running: say so and wait for the close gadget, as without a stack. */
            set_status(&G, "Could not listen on port 6800");
            wait_window(&G);
        }
        net_close();
    }
    rc = RETURN_OK;
out:
    ipc_close();
    if (G.app_win) RemoveAppWindow(G.app_win);
    if (G.app_port) { struct Message *m; while ((m = GetMsg(G.app_port)) != NULL) ReplyMsg(m); DeleteMsgPort(G.app_port); }
    if (G.win) CloseWindow(G.win);
    if (G.gl) FreeGadgets(G.gl);
    if (G.vi) FreeVisualInfo(G.vi);
    if (G.scr) UnlockPubScreen(NULL, G.scr);
    if (WorkbenchBase) CloseLibrary(WorkbenchBase);
    if (AslBase) CloseLibrary(AslBase);
    if (GadToolsBase) CloseLibrary(GadToolsBase);
    if (GfxBase) CloseLibrary((struct Library *)GfxBase);
    if (IntuitionBase) CloseLibrary((struct Library *)IntuitionBase);
    return rc;
}
