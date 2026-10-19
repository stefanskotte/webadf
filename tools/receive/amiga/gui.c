/* Receive's window: folder setting and the receiving queue. gadtools + asl only (V37). */
#include <stdio.h>
#include <string.h>
#include <exec/memory.h>
#include <intuition/intuition.h>
#include <libraries/gadtools.h>
#include <libraries/asl.h>
#include <proto/exec.h>
#include <proto/intuition.h>
#include <proto/gadtools.h>
#include <proto/graphics.h>
#include <proto/asl.h>
#include <proto/dos.h>
#include "afs.h"
#include "config.h"
#include "net.h"
#include "ui.h"

struct Library *GadToolsBase, *AslBase;
struct IntuitionBase *IntuitionBase;
struct GfxBase *GfxBase;

enum { G_DIR, G_CHOOSE, G_SAVE, G_STATUS, G_LIST, G_N };
#define ROWS_MAX 48
enum { ST_WAITING, ST_RECEIVING, ST_DONE, ST_FAILED };
typedef struct { struct Node node; char id[RX_ID_MAX + 1]; char name[RX_PATH_MAX + 1]; unsigned long size;
                 int state; unsigned pct; char why[40]; char text[80]; } row;

typedef struct {
    struct Window *win; struct Gadget *g[G_N]; APTR vi; struct Screen *scr;
    struct List list; row rows[ROWS_MAX]; int n;
    afs_ctx *ctx; rx_fs *fs; rx_session *s;
    char status[80]; char pending[256]; int has_pending; int quit;
    struct Gadget *gl;   /* CreateContext's list: freed after CloseWindow (FirstGadget includes system gadgets) */
} gui;

/* amiga.lib's NewList, without linking amiga.lib. */
static void new_list(struct List *l) { l->lh_Head = (struct Node *)&l->lh_Tail; l->lh_Tail = NULL; l->lh_TailPred = (struct Node *)&l->lh_Head; }

static void set_status(gui *G, const char *t) {
    strncpy(G->status, t, sizeof G->status - 1);
    if (G->win) GT_SetGadgetAttrs(G->g[G_STATUS], G->win, NULL, GTTX_Text, (ULONG)G->status, TAG_END);
}
static void row_text(row *r) {
    char nm[23]; const char *base = strrchr(r->name, '/'); size_t l;
    base = base ? base + 1 : r->name;
    strncpy(nm, base, 22); nm[22] = 0;
    l = strlen(nm); while (l < 22) nm[l++] = ' '; nm[22] = 0;
    switch (r->state) {
    case ST_WAITING: sprintf(r->text, "%s %5lu KB  waiting", nm, (r->size + 1023) / 1024); break;
    case ST_RECEIVING: sprintf(r->text, "%s %5lu KB  receiving %u%%", nm, (r->size + 1023) / 1024, r->pct); break;
    case ST_DONE: sprintf(r->text, "%s %5lu KB  done", nm, (r->size + 1023) / 1024); break;
    default: sprintf(r->text, "%s %5lu KB  failed: %.30s", nm, (r->size + 1023) / 1024, r->why); break;
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
static row *find(gui *G, const char *id) { int i; for (i = 0; i < G->n; i++) if (!strcmp(G->rows[i].id, id)) return &G->rows[i]; return NULL; }
static void drop_at(gui *G, int i) { memmove(&G->rows[i], &G->rows[i + 1], (size_t)(G->n - i - 1) * sizeof(row)); G->n--; }
static row *add(gui *G, const char *id) {
    int i;
    if (G->n == ROWS_MAX) {
        for (i = 0; i < G->n && (G->rows[i].state == ST_WAITING || G->rows[i].state == ST_RECEIVING); i++) ;
        if (i == G->n) return NULL;
        drop_at(G, i);
    }
    memset(&G->rows[G->n], 0, sizeof(row));
    strcpy(G->rows[G->n].id, id);
    return &G->rows[G->n++];
}
static void on_event(void *u, const rx_event *e, rx_session *s) {
    gui *G = u; row *r; unsigned i; int k;
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
        if ((r = find(G, e->id)) != NULL) r->pct = e->size ? (unsigned)(e->bytes / (e->size / 100 + 1)) : 0;
        if (r && r->pct > 99) r->pct = 99;
        break;
    case RX_EV_DONE:
        if ((r = find(G, e->id)) != NULL) { strcpy(r->name, e->path); r->state = ST_DONE; }
        if (G->has_pending) { afs_set_root(G->ctx, G->pending); G->has_pending = 0; }
        break;
    case RX_EV_FAILED:
        if ((r = find(G, e->id)) != NULL) { r->state = ST_FAILED; strncpy(r->why, e->text ? e->text : "", sizeof r->why - 1); }
        if (G->has_pending) { afs_set_root(G->ctx, G->pending); G->has_pending = 0; }
        break;
    default: return;
    }
    relist(G);
}
/* net_run reports "Listening on port 6800"; a missing folder says so instead, from the first draw. */
static void on_status(void *u, const char *t) { gui *G = u; set_status(G, G->fs->folder_ok(G->ctx) ? t : "Folder not found"); }
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
    gui *G = u; struct IntuiMessage *m;
    (void)sigs;
    while ((m = GT_GetIMsg(G->win->UserPort)) != NULL) {
        ULONG cls = m->Class; struct Gadget *gad = (struct Gadget *)m->IAddress;
        GT_ReplyIMsg(m);
        if (cls == IDCMP_CLOSEWINDOW) G->quit = 1;
        else if (cls == IDCMP_REFRESHWINDOW) { GT_BeginRefresh(G->win); GT_EndRefresh(G->win, TRUE); }
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_CHOOSE) choose(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_SAVE) save(G);
    }
    return G->quit;
}

static int build(gui *G, const char *dir) {
    struct NewGadget ng; struct Gadget *gl = NULL, *g;
    struct TextAttr *ta = G->scr->Font;
    struct TextFont *tf = OpenFont(ta);
    struct RastPort rp;
    UWORD fh = ta->ta_YSize, mw, lw, w, x0, y, gh, iw;
    InitRastPort(&rp);
    if (tf) SetFont(&rp, tf);
    mw = (UWORD)TextLength(&rp, (STRPTR)"M", 1);
    lw = (UWORD)TextLength(&rp, (STRPTR)"Save files to:", 14) + 8;
    w = (UWORD)TextLength(&rp, (STRPTR)"Choose...", 9) + 16;
    if (tf) CloseFont(tf);
    iw = (UWORD)(56 * mw);
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
    ng.ng_TopEdge = (WORD)y; ng.ng_GadgetText = (UBYTE *)"Save"; ng.ng_GadgetID = G_SAVE;
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
        WA_Title, (ULONG)"webadf Receive", WA_PubScreen, (ULONG)G->scr, WA_Gadgets, (ULONG)gl,
        WA_InnerWidth, iw, WA_InnerHeight, (ULONG)(y + ng.ng_Height + 6 - (G->scr->WBorTop + fh + 1)),
        WA_DragBar, TRUE, WA_DepthGadget, TRUE, WA_CloseGadget, TRUE, WA_Activate, TRUE, WA_SimpleRefresh, TRUE,
        WA_IDCMP, IDCMP_CLOSEWINDOW | IDCMP_REFRESHWINDOW | BUTTONIDCMP | STRINGIDCMP | LISTVIEWIDCMP, TAG_END);
    if (!G->win) { FreeGadgets(gl); G->gl = NULL; return -1; }
    GT_RefreshWindow(G->win, NULL);
    return 0;
}

int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send) {
    static gui G; static afs_ctx ctx; static rx_fs fs; static rx_session s; static rx_upq q;
    int rc = RETURN_FAIL;
    (void)wbargs; (void)nwb; (void)send;
    IntuitionBase = (struct IntuitionBase *)OpenLibrary((STRPTR)"intuition.library", 37);
    GfxBase = (struct GfxBase *)OpenLibrary((STRPTR)"graphics.library", 37);
    GadToolsBase = OpenLibrary((STRPTR)"gadtools.library", 37);
    AslBase = OpenLibrary((STRPTR)"asl.library", 37);
    if (!IntuitionBase || !GfxBase || !GadToolsBase || !AslBase) goto out;
    memset(&G, 0, sizeof G); new_list(&G.list);
    G.ctx = &ctx; G.fs = &fs; G.s = &s;
    afs_init(&ctx, &fs, dir);
    rx_upq_init(&q, "");
    strcpy(G.status, "Starting...");
    if (!(G.scr = LockPubScreen(NULL)) || !(G.vi = GetVisualInfo(G.scr, TAG_END))) goto out;
    if (build(&G, dir) != 0) goto out;
    if (net_open() != 0) {
        set_status(&G, "No TCP/IP stack running (bsdsocket.library)");
        while (!G.quit) {
            if (Wait(1UL << G.win->UserPort->mp_SigBit | SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) break;
            on_signal(&G, 0);
        }
    } else {
        net_ui ui;
        ui.u = &G; ui.on_event = on_event; ui.on_status = on_status;
        ui.extra_sigs = 1UL << G.win->UserPort->mp_SigBit; ui.on_signal = on_signal;
        ui.on_pass = NULL; ui.on_link = NULL;
        if (net_run(&ui, &ctx, &fs, &s, &q) != 0) {
            /* e.g. Receive is already running: say so and wait for the close gadget, as without a stack. */
            set_status(&G, "Could not listen on port 6800");
            while (!G.quit) {
                if (Wait(1UL << G.win->UserPort->mp_SigBit | SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) break;
                on_signal(&G, 0);
            }
        }
        net_close();
    }
    rc = RETURN_OK;
out:
    if (G.win) CloseWindow(G.win);
    if (G.gl) FreeGadgets(G.gl);
    if (G.vi) FreeVisualInfo(G.vi);
    if (G.scr) UnlockPubScreen(NULL, G.scr);
    if (AslBase) CloseLibrary(AslBase);
    if (GadToolsBase) CloseLibrary(GadToolsBase);
    if (GfxBase) CloseLibrary((struct Library *)GfxBase);
    if (IntuitionBase) CloseLibrary((struct Library *)IntuitionBase);
    return rc;
}
