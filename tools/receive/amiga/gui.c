/* Transfer's window (spec 2026-10-16 §5, 2026-10-18 §2): the folder, the board, and both directions in one list. It is
   an AppWindow: icons dropped on it go to the web app (a drawer walked, 64 files at most); Send... opens an asl
   requester (several files on V38+, one on V37). One row, "Web App: [x] Read [x] Write" (Transfer 2.7), lets the web
   app browse the Amiga's disks (read-only) and, only while Read is on, change them; the status line shows its last
   request. It is a commodity (cx.c, Transfer 2.7): Exchange and a hotkey show and hide it, the close gadget hides it,
   Project/Quit or Exchange's Kill end it. gadtools, asl, workbench and commodities only (V37). */
#include <stdio.h>
#include <stdlib.h>
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
#include "cx.h"
#include "ipc.h"
#include "net.h"
#include "ui.h"
#include "version.h"

/* Defined (= NULL), not tentative: a tentative base lets libstubs' own definition in, and libnix then opens that library
   at startup in every mode -- asl.library from disk, ~30 KB, which a 512 KB Amiga running the Shell form does not have
   to spare (bench 2026-10-31). The window opens its libraries itself, below. */
struct Library *GadToolsBase = NULL, *AslBase = NULL, *WorkbenchBase = NULL;
struct IntuitionBase *IntuitionBase = NULL;
struct GfxBase *GfxBase = NULL;

enum { G_DIR, G_CHOOSE, G_SEND, G_RETRY, G_TRUST, G_SAVE, G_WEBAPP, G_BROWSE, G_WRITE, G_STATUS, G_LIST, G_N };
#define ROWS_MAX 96
enum { ST_WAITING, ST_RECEIVING, ST_DONE, ST_FAILED, ST_UP_WAITING, ST_UP_MOVING, ST_UP_DONE, ST_UP_FAILED, ST_SKIPPED };
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
    /* Transfer 2.7: the window comes and goes (a commodity); what it shows outlives it. */
    char dirbuf[256];    /* the folder gadget's text while the window is hidden */
    int trust_on;        /* Trust this board is usable */
    int has_cx;          /* a broker: the close gadget hides */
    int disabled;        /* Exchange's Disable: net.c closes the connection and the listener */
    int want_hide;
    const char *note;    /* said instead of the first network status (no commodities.library, a bad hotkey) */
    struct Menu *menu;
    net_ui *ui;
} gui;

/* amiga.lib's NewList, without linking amiga.lib. */
static void new_list(struct List *l) { l->lh_Head = (struct Node *)&l->lh_Tail; l->lh_Tail = NULL; l->lh_TailPred = (struct Node *)&l->lh_Head; }

static void set_status(gui *G, const char *t) {
    strncpy(G->status, t, sizeof G->status - 1);
    if (G->win) GT_SetGadgetAttrs(G->g[G_STATUS], G->win, NULL, GTTX_Text, (ULONG)G->status, TAG_END);
}
static void set_trust_button(gui *G, int on) {
    G->trust_on = on;
    if (G->win) GT_SetGadgetAttrs(G->g[G_TRUST], G->win, NULL, GA_Disabled, (ULONG)(on ? FALSE : TRUE), TAG_END);
}
/* Every board before 1.19.0 connects this way to send files down: said only once something is to go up (as shell.c). */
#define OLD_FW "This board's firmware cannot receive files (update to 1.19.0)"
/* The name column: an AmigaDOS name is 30 at most, narrower only where the window has no room (window_open). text[80] holds
   the longest line: 30 + 1 + 7 + 1 + "to web: failed: " + 24. */
#define NAME_MAX_W 30
#define NAME_MIN_W 17
static int name_w = NAME_MAX_W;
static unsigned pct_of(unsigned long bytes, unsigned long size) {
    unsigned p = size ? (unsigned)(bytes / (size / 100 + 1)) : 0;
    return p > 99 ? 99 : p;
}
static void row_text(row *r) {
    char nm[NAME_MAX_W + 1], sz[16]; const char *base = strrchr(r->name, '/'); size_t l;
    /* Before the first '/', a volume's root: Work:a.txt shows as a.txt, as a drawer's file does. */
    if (!base) base = strchr(r->name, ':');
    base = base ? base + 1 : r->name;
    strncpy(nm, base, (size_t)name_w); nm[name_w] = 0;
    l = strlen(nm); while (l < (size_t)name_w) nm[l++] = ' '; nm[name_w] = 0;
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
    case ST_SKIPPED: sprintf(r->text, "%s %s skipped (it exists)", nm, sz); break;
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
        if (r) {
            strcpy(r->name, name); strncpy(r->local, path, RX_LOCAL_MAX); r->state = ST_UP_FAILED;
            strcpy(r->why, G->q->lost ? "not enough memory" : G->q->n >= RX_UP_MAX ? "too many files" : "cannot read it");
        }
    }
    relist(G);
    if (G->q->lost) {   /* spec 2026-10-31 §2.5: a failed malloc mid-walk says so */
        char t[60]; sprintf(t, "not enough memory: %u files not queued", G->q->lost); set_status(G, t);
    } else if (!G->connected && G->q->n) set_status(G, "Waiting for the board");
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
    char k4[5], t[80], w[80];
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
        if (strchr(e->path, ':')) { sprintf(t, "Web: copied to %.60s", e->path); set_status(G, t); }   /* protocol 4 */
        break;
    case RX_EV_SKIP:
        if (!(r = find(G, e->id))) r = add(G, e->id);
        if (r) { strcpy(r->name, e->path); r->size = e->size; r->state = ST_SKIPPED; }
        sprintf(t, "Web: skipped %.50s (it exists)", e->path); set_status(G, t);
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
        /* A GET's file that fails after GOT has no row yet (nothing began): add it, as UP_BEGIN does. */
        if (!(r = find_tag(G, e->tag)) && (r = add(G, "")) != NULL) { r->tag = e->tag; strcpy(r->name, e->path); }
        if (r) { r->state = ST_UP_FAILED; strncpy(r->why, e->text ? e->text : "", sizeof r->why - 1); }
        ipc_done(e->tag, 0, 0, e->text);
        break;
    case RX_EV_REQ:
        rx_req_words(e, w, sizeof w);
        sprintf(t, "Web: %.70s", w);
        set_status(G, t);
        return;
    default: return;
    }
    relist(G);
}
/* net_run reports "Listening on port 6800"; a missing folder says so instead, from the first draw. */
static void on_status(void *u, const char *t) {
    gui *G = u;
    if (G->note) { set_status(G, G->note); G->note = NULL; return; }
    set_status(G, strcmp(t, "Listening on port 6800") || G->fs->folder_ok(G->ctx) ? t : "Folder not found");
}
static int gui_off(void *u) { return ((gui *)u)->disabled; }
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
static void save(gui *G);
/* Transfer 2.9 (field report, 2026-11-01): a folder chosen, or typed and confirmed with Return, is saved at once --
   before, it took effect only after Save, and files kept going to the old folder. */
static void choose(gui *G) {
    struct FileRequester *fr = AllocAslRequestTags(ASL_FileRequest,
        ASLFR_Window, (ULONG)G->win, ASLFR_TitleText, (ULONG)"Save files to",
        ASLFR_InitialDrawer, (ULONG)dir_text(G), ASLFR_DrawersOnly, TRUE, TAG_END);
    if (!fr) return;
    if (AslRequest(fr, NULL)) {
        GT_SetGadgetAttrs(G->g[G_DIR], G->win, NULL, GTST_String, (ULONG)fr->fr_Drawer, TAG_END);
        save(G);
    }
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
/* The switch (spec 2026-10-30 §2.3; plan ruling T9): stored at once, in ENV: and ENVARC:. A connected board reconnects
   to hear it (rx_hello_stale, net.c). */
static void set_browse(gui *G, int on) {
    G->q->browse = on;
    /* spec 2026-10-31 §2.4: writing is usable only while browsing is on; unticking browsing unticks writing */
    if (!on && G->q->write) { G->q->write = 0; cfg_write_save(0); }
    rx_switch_changed(G->s);   /* Transfer 2.7: an absolute FILE being received stops now */
    if (G->win) GT_SetGadgetAttrs(G->g[G_WRITE], G->win, NULL, GTCB_Checked, (ULONG)(G->q->write ? TRUE : FALSE),
                                  GA_Disabled, (ULONG)(on ? FALSE : TRUE), TAG_END);
    if (cfg_browse_save(on) != 0) set_status(G, on ? "Browsing on (not saved: ENVARC:)" : "Browsing off (not saved: ENVARC:)");
    else set_status(G, on ? "Browsing on: the web app can read your disks" : "Browsing off");
}
/* The writing switch (spec 2026-10-31 §2.4), stored at once as the browsing one; a connected board reconnects. */
static void set_write(gui *G, int on) {
    G->q->write = on && G->q->browse;
    rx_switch_changed(G->s);
    if (cfg_write_save(G->q->write) != 0) set_status(G, on ? "Writing on (not saved: ENVARC:)" : "Writing off (not saved: ENVARC:)");
    else set_status(G, on ? "Writing on: the web app can change your disks" : "Writing off: the web app only reads");
}
static ULONG gui_sigs(gui *G) {
    return (G->win ? 1UL << G->win->UserPort->mp_SigBit : 0) | (G->app_port ? 1UL << G->app_port->mp_SigBit : 0) |
           ipc_sigmask() | cx_sigmask();
}
static void sync_sigs(gui *G) { if (G->ui) G->ui->extra_sigs = gui_sigs(G); }
static int show(gui *G);
static void hide(gui *G);
/* Project: About..., Hide (Amiga-H, only with a broker: without one nothing could show the window again), Quit
   (Amiga-Q). Item numbers count the bar after About. */
enum { MI_ABOUT = 0, MI_HIDE = 2, MI_QUIT = 3 };
static void about(gui *G) {
    struct EasyStruct es;
    es.es_StructSize = sizeof es; es.es_Flags = 0;
    es.es_Title = (UBYTE *)"About Transfer";
    es.es_TextFormat = (UBYTE *)"Transfer " TRANSFER_VERSION " (" TRANSFER_DATE ")\n\n"
        "Moves files between this Amiga and the\n"
        "WebFloppy web app, through the board.\n\n"
        "From webadf by Stefan Skotte\n"
        "github.com/stefanskotte/webadf";
    es.es_GadgetFormat = (UBYTE *)"OK";
    EasyRequestArgs(G->win, &es, NULL, NULL);
}
static void menu_pick(gui *G, UWORD code) {
    while (code != MENUNULL) {
        struct MenuItem *it = ItemAddress(G->menu, code);
        if (MENUNUM(code) == 0 && ITEMNUM(code) == MI_ABOUT) about(G);
        else if (MENUNUM(code) == 0 && ITEMNUM(code) == MI_HIDE && G->has_cx) G->want_hide = 1;
        else if (MENUNUM(code) == 0 && ITEMNUM(code) == MI_QUIT) G->quit = 1;
        if (!it) break;
        code = it->NextSelect;
    }
}
static int on_signal(void *u, ULONG sigs) {
    gui *G = u; struct IntuiMessage *m; struct AppMessage *am; LONG i; int cx;
    (void)sigs;
    while (G->win && (m = GT_GetIMsg(G->win->UserPort)) != NULL) {
        ULONG cls = m->Class; UWORD code = m->Code; struct Gadget *gad = (struct Gadget *)m->IAddress;
        GT_ReplyIMsg(m);
        if (cls == IDCMP_CLOSEWINDOW) { if (G->has_cx) G->want_hide = 1; else G->quit = 1; }
        else if (cls == IDCMP_MENUPICK) menu_pick(G, code);
        else if (cls == IDCMP_REFRESHWINDOW) { GT_BeginRefresh(G->win); GT_EndRefresh(G->win, TRUE); }
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_CHOOSE) choose(G);
        else if (cls == IDCMP_GADGETUP && (gad->GadgetID == G_SAVE || gad->GadgetID == G_DIR)) save(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_BROWSE) set_browse(G, (gad->Flags & GFLG_SELECTED) != 0);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_WRITE) set_write(G, (gad->Flags & GFLG_SELECTED) != 0);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_SEND) send_files(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_RETRY) retry_failed(G);
        else if (cls == IDCMP_GADGETUP && gad->GadgetID == G_TRUST && rx_trust_now(G->s) != 0) set_status(G, "No board to trust yet");
    }
    if (G->want_hide) { G->want_hide = 0; hide(G); }
    if (G->app_port) while ((am = (struct AppMessage *)GetMsg(G->app_port)) != NULL) {
        for (i = 0; i < am->am_NumArgs; i++) add_wbarg(G, &am->am_ArgList[i]);
        ReplyMsg((struct Message *)am);
    }
    ipc_take(G->q, on_added, gui_trust, G);
    cx = cx_take();   /* Exchange and the hotkey */
    if (cx & CX_DISABLE) G->disabled = 1;
    if (cx & CX_ENABLE) G->disabled = 0;
    if (cx & CX_HIDE) hide(G);
    if (cx & CX_SHOW) show(G);
    if (cx & CX_QUIT) G->quit = 1;
    relist(G);
    /* A drop, Send... or a Shell's SEND while a board before 1.19.0 is connected: say why nothing moves. */
    if (G->connected && G->old_board && G->q->n) set_status(G, OLD_FW);
    return G->quit;
}

static UWORD text_w(struct RastPort *rp, const char *s) { return (UWORD)(TextLength(rp, (STRPTR)s, (UWORD)strlen(s)) + 16); }

static struct NewMenu menus[] = {
    { NM_TITLE, (STRPTR)"Project", NULL, 0, 0, NULL },
    { NM_ITEM, (STRPTR)"About...", NULL, 0, 0, NULL },
    { NM_ITEM, NM_BARLABEL, NULL, 0, 0, NULL },
    { NM_ITEM, (STRPTR)"Hide", (STRPTR)"H", 0, 0, NULL },
    { NM_ITEM, (STRPTR)"Quit", (STRPTR)"Q", 0, 0, NULL },
    { NM_END, NULL, NULL, 0, 0, NULL }
};

/* The layout (Transfer 2.7, plan rulings R6, R7): a 6-pixel margin all round, 4 pixels between rows; the labels
   "Save files to:" and "Web App:" end in one column, where the folder field and the Read box start. */
#define CB_W 26    /* a V37 checkbox is 26 x 11 whatever the font */
#define CB_H 11
/* NewLook (V39) menus, or the classic ones -- as hdpart (github.com/stefanskotte/hdpart, src/gui.c) decides it: only
   with gadtools V39+ (Kickstart 3.0; 2.04 never sees the tag), on a screen opened with NewLook pens (DrawInfo version 2+
   with the bar pens), and only when the menu's text actually reads over its fill on this palette (an OS 3.2 tester's
   palette once had black on dark blue). */
static int luma4(ULONG rgb4) { return (int)((((rgb4 >> 8) & 0xF) * 77 + ((rgb4 >> 4) & 0xF) * 151 + (rgb4 & 0xF) * 28) >> 8); }
static int pen_luma(struct Screen *scr, int pen) {
    struct ColorMap *cm = scr->ViewPort.ColorMap;
    if (pen >= 0xFEFC) return -2;   /* a V39 "magic" pen: the complement of colours 0-3, contrasting by construction */
    if (!cm || pen < 0 || pen >= (int)cm->Count) return -1;
    return luma4(GetRGB4(cm, pen));
}
static int pens_readable(struct Screen *scr, int fg, int bg) {
    int lf = pen_luma(scr, fg), lb = pen_luma(scr, bg), d;
    if (lf == -2 || lb == -2) return 1;
    if (lf < 0 || lb < 0) return 0;
    d = lf - lb; if (d < 0) d = -d;
    return d >= 4;   /* of 15 */
}
static int menus_newlook(struct Screen *scr) {
    struct DrawInfo *dri; int ok = 0;
    if (!GadToolsBase || GadToolsBase->lib_Version < 39 || !(dri = GetScreenDrawInfo(scr))) return 0;
    if ((dri->dri_Flags & DRIF_NEWLOOK) && dri->dri_Version >= 2 && dri->dri_Pens && dri->dri_NumPens > BARBLOCKPEN)
        ok = pens_readable(scr, (int)dri->dri_Pens[BARDETAILPEN], (int)dri->dri_Pens[BARBLOCKPEN]) &&
             pens_readable(scr, (int)dri->dri_Pens[FILLTEXTPEN], (int)dri->dri_Pens[FILLPEN]);
    FreeScreenDrawInfo(scr, dri);
    return ok;
}
static int build(gui *G) {
    struct NewGadget ng; struct Gadget *gl = NULL, *g; int newlook;
    struct TextAttr *ta = G->scr->Font;
    struct TextFont *tf = OpenFont(ta);
    struct RastPort rp;
    UWORD fh = ta->ta_YSize, mw, lw, lw2, w, wsend, wretry, wtrust, wread, x0, right, top, y, gh, iw, row2, lh;
    InitRastPort(&rp);
    if (tf) SetFont(&rp, tf);
    mw = (UWORD)TextLength(&rp, (STRPTR)"M", 1);
    lw = (UWORD)TextLength(&rp, (STRPTR)"Save files to:", 14) + 8;
    lw2 = (UWORD)TextLength(&rp, (STRPTR)"Web App:", 8) + 8;
    if (lw < lw2) lw = lw2;
    wread = (UWORD)TextLength(&rp, (STRPTR)"Read", 4);
    w = text_w(&rp, "Choose...");
    wsend = text_w(&rp, "Send..."); wretry = text_w(&rp, "Retry failed"); wtrust = text_w(&rp, "Trust this board");
    if (tf) CloseFont(tf);
    iw = (UWORD)(77 * mw);   /* room for "to web: failed: connection lost" in the list; 616 px with topaz 8 */
    row2 = (UWORD)(wsend + wretry + wtrust + w + 3 * 6 + 12);   /* the second row's buttons, side by side */
    if (iw < row2) iw = row2;
    if (iw > G->scr->Width - 24) iw = (UWORD)(G->scr->Width - 24);
    {   /* Characters in the list (its scroller about 20 px) less size, gaps and "to web: failed: connection lost". */
        int cols = (iw - 12 - 20) / (mw ? mw : 8) - 9 - 31;
        name_w = cols > NAME_MAX_W ? NAME_MAX_W : cols < NAME_MIN_W ? NAME_MIN_W : cols;
    }
    top = (UWORD)(G->scr->WBorTop + fh + 1);   /* the title bar */
    x0 = (UWORD)(G->scr->WBorLeft + 6); right = (UWORD)(x0 + iw - 12); y = (UWORD)(top + 6); gh = (UWORD)(fh + 6);
    g = CreateContext(&gl);
    memset(&ng, 0, sizeof ng);
    ng.ng_VisualInfo = G->vi; ng.ng_TextAttr = ta;
    ng.ng_LeftEdge = (WORD)(x0 + lw); ng.ng_TopEdge = (WORD)y; ng.ng_Width = (WORD)(right - w - 6 - x0 - lw); ng.ng_Height = (WORD)gh;
    ng.ng_GadgetText = (UBYTE *)"Save files to:"; ng.ng_GadgetID = G_DIR; ng.ng_Flags = PLACETEXT_LEFT;
    G->g[G_DIR] = g = CreateGadget(STRING_KIND, g, &ng, GTST_String, (ULONG)G->dirbuf, GTST_MaxChars, 255, TAG_END);
    ng.ng_LeftEdge = (WORD)(right - w); ng.ng_Width = (WORD)w; ng.ng_GadgetText = (UBYTE *)"Choose...";
    ng.ng_GadgetID = G_CHOOSE; ng.ng_Flags = PLACETEXT_IN;
    G->g[G_CHOOSE] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    y = (UWORD)(y + gh + 4);
    ng.ng_TopEdge = (WORD)y;
    ng.ng_LeftEdge = (WORD)x0; ng.ng_Width = (WORD)wsend; ng.ng_GadgetText = (UBYTE *)"Send..."; ng.ng_GadgetID = G_SEND;
    G->g[G_SEND] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + wsend + 6); ng.ng_Width = (WORD)wretry; ng.ng_GadgetText = (UBYTE *)"Retry failed"; ng.ng_GadgetID = G_RETRY;
    G->g[G_RETRY] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + wsend + wretry + 12); ng.ng_Width = (WORD)wtrust; ng.ng_GadgetText = (UBYTE *)"Trust this board"; ng.ng_GadgetID = G_TRUST;
    G->g[G_TRUST] = g = CreateGadget(BUTTON_KIND, g, &ng, GA_Disabled, (ULONG)(G->trust_on ? FALSE : TRUE), TAG_END);
    ng.ng_LeftEdge = (WORD)(right - w); ng.ng_Width = (WORD)w; ng.ng_GadgetText = (UBYTE *)"Save"; ng.ng_GadgetID = G_SAVE;
    G->g[G_SAVE] = g = CreateGadget(BUTTON_KIND, g, &ng, TAG_END);
    /* The switches (spec 2026-10-30 §2.3, 2026-10-31 §2.4) on one row: "Web App:" is a borderless text gadget's label
       (zero wide, so it never takes a click), Read and Write the boxes' own labels; Write is greyed while Read is off. */
    y = (UWORD)(y + gh + 4);
    /* One line lower than the box: GadTools centres a checkbox's label one line lower than a text gadget's (seen on
       3.1, 2026-11-01), so the three labels share a baseline. */
    ng.ng_LeftEdge = (WORD)(x0 + lw); ng.ng_TopEdge = (WORD)(y + (gh - CB_H) / 2 + 1); ng.ng_Width = 0; ng.ng_Height = CB_H;
    ng.ng_GadgetText = (UBYTE *)"Web App:"; ng.ng_GadgetID = G_WEBAPP; ng.ng_Flags = PLACETEXT_LEFT;
    G->g[G_WEBAPP] = g = CreateGadget(TEXT_KIND, g, &ng, TAG_END);
    ng.ng_TopEdge = (WORD)(y + (gh - CB_H) / 2); ng.ng_Width = CB_W;
    ng.ng_GadgetText = (UBYTE *)"Read"; ng.ng_GadgetID = G_BROWSE; ng.ng_Flags = PLACETEXT_RIGHT;
    G->g[G_BROWSE] = g = CreateGadget(CHECKBOX_KIND, g, &ng, GTCB_Checked, (ULONG)(G->q->browse ? TRUE : FALSE), TAG_END);
    ng.ng_LeftEdge = (WORD)(x0 + lw + CB_W + 8 + wread + 16); ng.ng_GadgetText = (UBYTE *)"Write"; ng.ng_GadgetID = G_WRITE;
    G->g[G_WRITE] = g = CreateGadget(CHECKBOX_KIND, g, &ng, GTCB_Checked, (ULONG)(G->q->write ? TRUE : FALSE),
                                     GA_Disabled, (ULONG)(G->q->browse ? FALSE : TRUE), TAG_END);
    ng.ng_Flags = PLACETEXT_IN;
    y = (UWORD)(y + gh + 4);
    ng.ng_LeftEdge = (WORD)x0; ng.ng_TopEdge = (WORD)y; ng.ng_Width = (WORD)(right - x0); ng.ng_Height = (WORD)gh;
    ng.ng_GadgetText = NULL; ng.ng_GadgetID = G_STATUS;
    G->g[G_STATUS] = g = CreateGadget(TEXT_KIND, g, &ng, GTTX_Text, (ULONG)G->status, GTTX_Border, TRUE, TAG_END);
    y = (UWORD)(y + gh + 4);
    lh = (UWORD)(8 * fh + 4);   /* eight whole lines: GadTools drops a part line, which left a gap under the list */
    ng.ng_TopEdge = (WORD)y; ng.ng_Height = (WORD)lh; ng.ng_GadgetID = G_LIST;
    G->g[G_LIST] = g = CreateGadget(LISTVIEW_KIND, g, &ng, GTLV_Labels, (ULONG)&G->list, GTLV_ReadOnly, TRUE, TAG_END);
    G->gl = gl;
    if (!g) return -1;
    menus[1 + MI_HIDE].nm_Flags = G->has_cx ? 0 : NM_ITEMDISABLED;
    newlook = menus_newlook(G->scr);
    /* NewLook takes all three or none (hdpart's finding): CreateMenus, LayoutMenus and the window's WA_NewLookMenus. A
       V37 GadTools never sees the V39 tag. */
    G->menu = newlook ? CreateMenus(menus, GTMN_NewLookMenus, TRUE, TAG_END) : CreateMenus(menus, TAG_END);
    if (G->menu && !(newlook ? LayoutMenus(G->menu, G->vi, GTMN_NewLookMenus, TRUE, TAG_END) : LayoutMenus(G->menu, G->vi, TAG_END))) {
        FreeMenus(G->menu); G->menu = NULL;
    }
    G->win = OpenWindowTags(NULL,
        WA_Title, (ULONG)"WebFloppy - Receive & Send", WA_ScreenTitle, (ULONG)"Transfer " TRANSFER_VERSION " - WebFloppy",
        WA_NewLookMenus, (ULONG)(newlook ? TRUE : FALSE), WA_PubScreen, (ULONG)G->scr, WA_Gadgets, (ULONG)gl,
        WA_InnerWidth, iw, WA_InnerHeight, (ULONG)(y + lh + 6 - top),
        WA_DragBar, TRUE, WA_DepthGadget, TRUE, WA_CloseGadget, TRUE, WA_Activate, TRUE, WA_SimpleRefresh, TRUE,
        /* No INTUITICKS, which LISTVIEWIDCMP asks for: Intuition sends them only to the active window, about 10 a second, and
           each one wakes WaitSelect in net.c. With this window active, a copy stopped within seconds until it was
           deactivated (A500 bench 2026-11-02, twice; without ticks 66 files, none stopped). The cost: holding a list arrow
           no longer repeats; a click steps and the scroller drags. */
        WA_IDCMP, (IDCMP_CLOSEWINDOW | IDCMP_REFRESHWINDOW | IDCMP_MENUPICK | BUTTONIDCMP | STRINGIDCMP | LISTVIEWIDCMP) & ~IDCMP_INTUITICKS, TAG_END);
    if (!G->win) return -1;
    if (G->menu) SetMenuStrip(G->win, G->menu);
    GT_RefreshWindow(G->win, NULL);
    return 0;
}

/* The window opens (Exchange's Show, the hotkey, a second start) and closes (the close gadget, Hide) while Transfer
   keeps serving; the folder text, the switches, the Trust state and the list stay in G. */
static void hide(gui *G) {
    if (G->win) strncpy(G->dirbuf, dir_text(G), sizeof G->dirbuf - 1);
    if (G->app_win) { RemoveAppWindow(G->app_win); G->app_win = NULL; }
    if (G->win) { if (G->menu) ClearMenuStrip(G->win); CloseWindow(G->win); G->win = NULL; }
    if (G->menu) { FreeMenus(G->menu); G->menu = NULL; }
    if (G->gl) { FreeGadgets(G->gl); G->gl = NULL; }
    if (G->vi) { FreeVisualInfo(G->vi); G->vi = NULL; }
    if (G->scr) { UnlockPubScreen(NULL, G->scr); G->scr = NULL; }
    sync_sigs(G);
}
static int show(gui *G) {
    if (G->win) { WindowToFront(G->win); ActivateWindow(G->win); return 0; }
    if (!(G->scr = LockPubScreen(NULL)) || !(G->vi = GetVisualInfo(G->scr, TAG_END)) || build(G) != 0) { hide(G); return -1; }
    if (G->app_port) G->app_win = AddAppWindowA(0, 0, G->win, G->app_port, NULL);
    sync_sigs(G);
    return 0;
}

/* Without a network (no stack, or port 6800 taken) the window still takes drops, Send... and Shell hand-offs. */
static void wait_window(gui *G) {
    while (!G->quit) {
        ULONG sigs = Wait(gui_sigs(G) | SIGBREAKF_CTRL_C);
        if (sigs & SIGBREAKF_CTRL_C) break;
        on_signal(G, sigs);
    }
}

int gui_main(const char *dir, struct WBArg *wbargs, long nwb, STRPTR *send, int trust, int browse, int write, const cx_opts *cx) {
    /* G (68 KB: 96 rows) and the session are malloc'd here, not static, so a Shell run never holds them (512 KB bench,
       spec 2026-10-30 §7 step 8); libnix frees them with the program. */
    static afs_ctx ctx; static rx_fs fs; static rx_upq q;
    gui *G = calloc(1, sizeof *G); rx_session *s = calloc(1, sizeof *s);
    net_ui ui;
    char key[RX_KEY_HEX + 8];
    long i;
    int rc = RETURN_FAIL, k;
    if (!G || !s) { PrintFault(ERROR_NO_FREE_STORE, (STRPTR)"Transfer"); return RETURN_FAIL; }
    memset(&ui, 0, sizeof ui);
    IntuitionBase = (struct IntuitionBase *)OpenLibrary((STRPTR)"intuition.library", 37);
    GfxBase = (struct GfxBase *)OpenLibrary((STRPTR)"graphics.library", 37);
    GadToolsBase = OpenLibrary((STRPTR)"gadtools.library", 37);
    AslBase = OpenLibrary((STRPTR)"asl.library", 37);
    WorkbenchBase = OpenLibrary((STRPTR)"workbench.library", 37);   /* none (no Workbench): no drops, the rest works */
    if (!IntuitionBase || !GfxBase || !GadToolsBase || !AslBase) goto out;
    /* Before anything shows: a second start only shows the first one's window (plan ruling R10). */
    k = cx_open(cx);
    if (k == 1) {
        if (cx->shell) PutStr((STRPTR)"Transfer is already running: its window is shown\n");
        rc = RETURN_OK; goto out;
    }
    G->has_cx = k == 0;
    /* any broker failure (no commodities.library, or no memory for it): review minor 2 */
    if (!G->has_cx) G->note = "No Exchange: closing the window stops Transfer";
    else if (cx_hotkey_bad()) G->note = "Hotkey not understood (CX_POPKEY): none set";
    new_list(&G->list);
    G->ctx = &ctx; G->fs = &fs; G->s = s; G->q = &q; G->ui = &ui;
    strncpy(G->dirbuf, dir, sizeof G->dirbuf - 1);
    afs_init(&ctx, &fs, dir);
    cfg_key_load(key, sizeof key);
    rx_upq_init(&q, key);
    q.browse = browse; q.write = write && browse;
    if (trust) gui_trust(G);   /* Transfer GUI TRUST (ruling PF18): as the Shell form, the next board's key is trusted */
    strcpy(G->status, "Starting...");
    strcpy(G->okstatus, "Listening on port 6800");
    if (WorkbenchBase) G->app_port = CreateMsgPort();
    /* CX_POPUP=NO starts hidden, only with a broker: without one nothing could show the window (ruling R9). */
    if ((!G->has_cx || cx->popup) && show(G) != 0) goto out;
    ipc_open();
    sync_sigs(G);
    for (i = 0; i < nwb; i++) add_wbarg(G, &wbargs[i]);           /* shift-clicked project icons */
    for (i = 0; send && send[i]; i++) add_path(G, (const char *)send[i]);   /* Transfer GUI SEND ... */
    if (net_open() != 0) {
        set_status(G, "No TCP/IP stack running (bsdsocket.library)");
        wait_window(G);
    } else {
        ui.u = G; ui.on_event = on_event; ui.on_status = on_status;
        ui.on_signal = on_signal; ui.on_pass = gui_pass; ui.on_link = on_link; ui.off = gui_off;
        sync_sigs(G);
        if (net_run(&ui, &ctx, &fs, s, &q) != 0) {
            /* e.g. Transfer is already running: say so and wait for the close gadget, as without a stack. */
            set_status(G, "Could not listen on port 6800");
            wait_window(G);
        }
        net_close();
    }
    rc = RETURN_OK;
out:
    ipc_close();
    hide(G);
    if (G->app_port) { struct Message *m; while ((m = GetMsg(G->app_port)) != NULL) ReplyMsg(m); DeleteMsgPort(G->app_port); }
    cx_close();
    if (WorkbenchBase) CloseLibrary(WorkbenchBase);
    if (AslBase) CloseLibrary(AslBase);
    if (GadToolsBase) CloseLibrary(GadToolsBase);
    if (GfxBase) CloseLibrary((struct Library *)GfxBase);
    if (IntuitionBase) CloseLibrary((struct Library *)IntuitionBase);
    return rc;
}
