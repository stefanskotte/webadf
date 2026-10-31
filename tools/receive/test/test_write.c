/* Protocol 4 (spec docs/superpowers/specs/2026-10-31-net-volumes-writes-design.md §2): the web app writes to the
   Amiga's own disks, only while the owner ticked "Let the web app change my disks". */
#include <stdio.h>
#include <stdlib.h>
#include "harness.h"
#include "rx_crc.h"
#include "fakefs.h"

#define KEY "0123456789abcdef0123456789abcdef"
#define KEY2 "fedcba9876543210fedcba9876543210"
static fakefs F; static rx_fs FS; static rx_session S; static rx_upq Q;
#define EV_MAX 512
static rx_event ev[EV_MAX]; static int n_ev;
static char ev_path[EV_MAX][300], ev_text[EV_MAX][100], ev_code[EV_MAX][20], ev_id[EV_MAX][48], ev_to[EV_MAX][300];
static int ev_has_text[EV_MAX];
static void on_ev(void *u, const rx_event *e) {
    (void)u;
    if (n_ev >= EV_MAX) return;
    ev[n_ev] = *e;
    snprintf(ev_path[n_ev], 300, "%s", e->path ? e->path : "");
    snprintf(ev_text[n_ev], 100, "%s", e->text ? e->text : "");
    ev_has_text[n_ev] = e->text != NULL;
    snprintf(ev_code[n_ev], 20, "%s", e->code ? e->code : "");
    snprintf(ev_id[n_ev], 48, "%s", e->id ? e->id : "");
    snprintf(ev_to[n_ev], 300, "%s", e->to ? e->to : "");
    ev[n_ev].path = NULL; ev[n_ev].text = NULL; ev[n_ev].code = NULL; ev[n_ev].id = NULL; ev[n_ev].key = NULL; ev[n_ev].to = NULL;
    n_ev++;
}
static int last_ev(int kind) { int i; for (i = n_ev - 1; i >= 0; i--) if (ev[i].kind == kind) return i; return -1; }
static void vol(const char *name, const char *dev) {
    rx_vol *v = &F.vols[F.nvols++];
    memset(v, 0, sizeof *v);
    snprintf(v->name, sizeof v->name, "%s", name); snprintf(v->device, sizeof v->device, "%s", dev);
    v->size = 1000000; v->free = 500000;
}
/* browse, write: the owner's two switches. Two volumes: Work (DH0:) and Floppy (DF0:). */
static void setup(int browse, int write) {
    ff_init(&F, &FS); n_ev = 0;
    rx_upq_init(&Q, KEY); Q.browse = browse; Q.write = write;
    rx_init(&S, &FS, on_ev, NULL); rx_attach(&S, &Q);
    vol("Work", "DH0:"); vol("Floppy", "DF0:");
    ff_add(&F, "Work:", 1); ff_add(&F, "Floppy:", 1);
}
static int feed(const char *str) { return rx_feed(&S, (const unsigned char *)str, strlen(str)); }
static int feedn(const char *str, unsigned long n) { return rx_feed(&S, (const unsigned char *)str, n); }
static char ob[400000]; static unsigned ob_n; static int passes, max_take;
static void drain(void) {
    static char b[RX_UP_BLOCK + 1];
    ob_n = 0; ob[0] = 0; passes = 0; max_take = 0;
    while (rx_want_output(&S) && passes < 100000) {
        int k = rx_take_output(&S, b, sizeof b - 1);
        passes++;
        if (k < 0) break;
        if (k > max_take) max_take = k;
        memcpy(ob + ob_n, b, (size_t)k); ob_n += (unsigned)k; ob[ob_n] = 0;
    }
}
static void hello4(void) { feed("WEBADF 4 " KEY "\n"); drain(); }
static int lines_starting(const char *prefix) {
    int n = 0; const char *p = ob; size_t k = strlen(prefix);
    while (*p) { if (strncmp(p, prefix, k) == 0) n++; p = strchr(p, '\n'); if (!p) break; p++; }
    return n;
}

/* --- Task 1: the hello and the switch --- */
static void a_protocol_4_hello_answers_both_switches(void) {
    setup(1, 1); hello4(); CHECK(strcmp(ob, "READY 4 1 1\n") == 0, ob);
    CHECK(rx_write_on(&S), "writing on");
    setup(1, 0); hello4(); CHECK(strcmp(ob, "READY 4 1 0\n") == 0, ob);
    CHECK(!rx_write_on(&S), "writing off");
    setup(0, 1); hello4(); CHECK(strcmp(ob, "READY 4 0 0\n") == 0, "writing needs browsing");
    CHECK(!rx_write_on(&S), "off without browsing");
    setup(1, 1); feed("WEBADF 4 " KEY2 "\n"); drain(); CHECK(strcmp(ob, "READY 4 0 0\n") == 0, "another key: neither");
    setup(1, 1); feed("WEBADF 9 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 4 1 1\n") == 0, "a newer board is answered as 4");
}
static void older_hellos_are_answered_as_before(void) {
    setup(1, 1); feed("WEBADF 3 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 3 1\n") == 0, ob);
    CHECK(!rx_write_on(&S), "never writes on protocol 3");
    setup(1, 1); feed("WEBADF 2 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 2\n") == 0, ob);
    setup(1, 1); feed("WEBADF 1\n"); drain(); CHECK(strcmp(ob, "READY 1\n") == 0, ob);
}
static void a_changed_write_switch_makes_the_hello_stale(void) {
    setup(1, 1); hello4();
    CHECK(!rx_hello_stale(&S), "as said");
    Q.write = 0; CHECK(rx_hello_stale(&S), "writing off: close, so the board hears READY 4 1 0");
    Q.write = 1; CHECK(!rx_hello_stale(&S), "back");
    Q.browse = 0; CHECK(rx_hello_stale(&S), "browsing off takes writing with it");
    setup(1, 0); feed("WEBADF 3 " KEY "\n"); drain(); Q.write = 1;
    CHECK(!rx_hello_stale(&S), "protocol 3 never hears the write flag");
}

int main(void) {
    RUN(a_protocol_4_hello_answers_both_switches); RUN(older_hellos_are_answered_as_before);
    RUN(a_changed_write_switch_makes_the_hello_stale);
    (void)feedn; (void)lines_starting; (void)last_ev; (void)ff_put;
    return REPORT();
}
