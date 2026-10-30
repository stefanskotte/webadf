/* Protocol 3 (spec docs/superpowers/specs/2026-10-30-net-volumes-design.md §2): the web app browses the Amiga. */
#include <stdio.h>
#include <stdlib.h>
#include "harness.h"
#include "rx_crc.h"
#include "fakefs.h"

#define KEY "0123456789abcdef0123456789abcdef"
#define KEY2 "fedcba9876543210fedcba9876543210"
static fakefs F; static rx_fs FS; static rx_session S; static rx_upq Q;
static rx_event ev[64]; static int n_ev;
static char ev_path[64][300], ev_text[64][100], ev_code[64][20], ev_id[64][48]; static int ev_has_text[64];
static void on_ev(void *u, const rx_event *e) {
    (void)u;
    if (n_ev >= 64) return;
    ev[n_ev] = *e;
    snprintf(ev_path[n_ev], 300, "%s", e->path ? e->path : "");
    snprintf(ev_text[n_ev], 100, "%s", e->text ? e->text : "");
    ev_has_text[n_ev] = e->text != NULL;
    snprintf(ev_code[n_ev], 20, "%s", e->code ? e->code : "");
    snprintf(ev_id[n_ev], 48, "%s", e->id ? e->id : "");
    ev[n_ev].path = NULL; ev[n_ev].text = NULL; ev[n_ev].code = NULL; ev[n_ev].id = NULL; ev[n_ev].key = NULL;
    n_ev++;
}
static int last_req(void) { int i; for (i = n_ev - 1; i >= 0; i--) if (ev[i].kind == RX_EV_REQ) return i; return -1; }
static void setup(int browse) {
    ff_init(&F, &FS); n_ev = 0;
    rx_upq_init(&Q, KEY); Q.browse = browse;
    rx_init(&S, &FS, on_ev, NULL); rx_attach(&S, &Q);
}
static int feed(const char *str) { return rx_feed(&S, (const unsigned char *)str, strlen(str)); }
/* What Transfer has to say now, taken as the net loop takes it: pass after pass while rx_want_output says so. */
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
static void hello3(void) { feed("WEBADF 3 " KEY "\n"); }
static int lines_starting(const char *prefix) {
    int n = 0; const char *p = ob; size_t k = strlen(prefix);
    while (*p) { if (strncmp(p, prefix, k) == 0) n++; p = strchr(p, '\n'); if (!p) break; p++; }
    return n;
}
static void vol(const char *name, const char *dev, unsigned long size, unsigned long fr, unsigned long d) {
    rx_vol *v = &F.vols[F.nvols++];
    memset(v, 0, sizeof *v);
    snprintf(v->name, sizeof v->name, "%s", name); snprintf(v->device, sizeof v->device, "%s", dev);
    v->size = size; v->free = fr; v->days = d; v->mins = d + 1; v->ticks = d + 2;
}

static void a_protocol_3_hello_answers_ready_3_with_the_switch(void) {
    setup(0); hello3(); drain(); CHECK(strcmp(ob, "READY 3 0\n") == 0, ob);
    CHECK_EQ_INT(ev[0].kind, RX_EV_HELLO); CHECK_EQ_INT(ev[1].kind, RX_EV_TRUST); CHECK(strcmp(ev_code[1], "ok") == 0, ev_code[1]);
    setup(1); hello3(); drain(); CHECK(strcmp(ob, "READY 3 1\n") == 0, ob);
    setup(1); feed("WEBADF 7 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 3 1\n") == 0, "a newer board is answered as 3");
    setup(1); feed("WEBADF 2 " KEY "\n"); drain(); CHECK(strcmp(ob, "READY 2\n") == 0, "protocol 2 unchanged");
    setup(1); feed("WEBADF 1\n"); drain(); CHECK(strcmp(ob, "READY 1\n") == 0, "protocol 1 unchanged");
}
static void another_boards_key_hears_browsing_off(void) {
    setup(1); feed("WEBADF 3 " KEY2 "\n"); drain();
    CHECK(strcmp(ob, "READY 3 0\n") == 0, ob);
    feed("VOLS r1\n"); drain();
    CHECK(strcmp(ob, "ERR r1 off 27:browsing is off in Transfer\n") == 0, ob);
}
static void requests_while_off_are_refused_off(void) {
    setup(0); vol("Work", "DH0:", 1, 1, 1); hello3(); drain();
    feed("VOLS r1\n"); drain();
    CHECK(strcmp(ob, "ERR r1 off 27:browsing is off in Transfer\n") == 0, ob);
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_code[i], "vols") == 0 && strcmp(ev_text[i], "browsing is off in Transfer") == 0, "the owner sees it"); }
}
static void malformed_requests_are_bad(void) {
    setup(1); hello3(); drain();
    feed("VOLS\n"); drain(); CHECK(strcmp(ob, "ERR - bad 11:bad request\n") == 0, ob);
    feed("VOLS r1 extra\n"); drain(); CHECK(strcmp(ob, "ERR r1 bad 11:bad request\n") == 0, ob);
    feed("VOLS aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"); drain(); CHECK(strcmp(ob, "ERR - bad 11:bad request\n") == 0, "a 41-byte id");
    feed("VOLS r.1\n"); drain(); CHECK(strcmp(ob, "ERR - bad 11:bad request\n") == 0, "a dot in the id");
}
static void volumes_are_listed_by_plain_name_duplicates_included(void) {
    setup(1);
    vol("Work", "DH0:", 104857600, 43000000, 1); vol("Empty", "DF0:", 901120, 0, 4); vol("Empty", "DF2:", 901120, 0, 4);
    vol("RAM Disk", "RAM:", 0, 1000, 7);
    hello3(); drain(); feed("VOLS v1\n"); drain();
    CHECK(strcmp(ob, "VOL v1 4:Work 4:DH0: 104857600 43000000 1.2.3\n"
                     "VOL v1 5:Empty 4:DF0: 901120 0 4.5.6\n"
                     "VOL v1 5:Empty 4:DF2: 901120 0 4.5.6\n"
                     "VOL v1 8:RAM Disk 4:RAM: 0 1000 7.8.9\n"
                     "DONE v1 4\n") == 0, ob);
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_code[i], "vols") == 0 && !ev_has_text[i] && ev[i].size == 4, "the owner sees it"); }
    CHECK(!rx_want_output(&S), "nothing more to say");
}
static void volumes_the_web_app_cannot_name_are_left_out(void) {
    setup(1);
    vol("Bad\x01", "DF0:", 1, 1, 1); vol("1234567890123456789012345678901", "DF1:", 1, 1, 1);
    vol("Good", "DH0:", 1, 1, 1); vol("Spaced", "D H1:", 1, 1, 1); vol("NoDevice", "", 1, 1, 1);
    hello3(); drain(); feed("VOLS v2\n"); drain();
    CHECK(strcmp(ob, "VOL v2 4:Good 4:DH0: 1 1 1.2.3\nDONE v2 1\n") == 0, ob);
}
static void a_failed_volume_list_is_io(void) {
    setup(1); F.vols_fail = 1; hello3(); drain();
    feed("VOLS v3\n"); drain();
    CHECK(strcmp(ob, "ERR v3 io 27:cannot read the volume list\n") == 0, ob);
}
static void many_volumes_are_paced_by_the_buffer(void) {
    int i; char dev[8];
    setup(1);
    for (i = 0; i < RX_VOLS_MAX; i++) { sprintf(dev, "DH%d:", i); vol("abcdefghijklmnopqrstuvwxyz0123", dev, 4000000000UL, 3000000000UL, 99999); }
    hello3(); drain();
    feed("VOLS aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"); drain();
    CHECK_EQ_INT(lines_starting("VOL "), RX_VOLS_MAX);
    CHECK(strstr(ob, "DONE aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 32\n") != NULL, "DONE 32");
    CHECK(max_take <= RX_OUT_MAX, "never more than the 1 KB buffer at once");
    CHECK(passes >= 4, "several passes");
}
static void a_second_request_while_one_waits_is_busy(void) {
    setup(1); vol("Work", "DH0:", 1, 1, 1);
    ff_put(&F, "DH0:One", "1", 1, 0, ""); CHECK_EQ_INT(rx_up_add(&Q, "DH0:One", "One"), 1);
    hello3(); drain(); CHECK(strncmp(ob, "READY 3 1\nPUT 1 1 ", 18) == 0, ob);   /* One is going up */
    feed("VOLS a\nVOLS b\n"); drain();
    CHECK(strcmp(ob, "ERR b busy 26:another request is waiting\n") == 0, ob);
    feed("TAKE 1 0 1\n"); drain();                   /* the byte, then END */
    CHECK(strstr(ob, "VOL a") == NULL, "a waits while the file is going up");
    feed("DONE 1 3:One\n"); drain();
    CHECK(strcmp(ob, "VOL a 4:Work 4:DH0: 1 1 1.2.3\nDONE a 1\n") == 0, ob);
}
static void a_changed_switch_makes_the_hello_stale_once_idle(void) {
    setup(1); vol("Work", "DH0:", 1, 1, 1); hello3(); drain();
    CHECK(!rx_hello_stale(&S), "as said");
    Q.browse = 0; CHECK(rx_hello_stale(&S), "switched off: close, so the board hears READY 3 0");
    Q.browse = 1; CHECK(!rx_hello_stale(&S), "switched back");
    feed("VOLS v\n"); Q.browse = 0;
    CHECK(!rx_hello_stale(&S), "not while a request waits");
    drain(); CHECK(strcmp(ob, "VOL v 4:Work 4:DH0: 1 1 1.2.3\nDONE v 1\n") == 0, "the accepted request is answered");
    CHECK(rx_hello_stale(&S), "then stale");
    setup(1); feed("WEBADF 2 " KEY "\n"); drain(); Q.browse = 0; CHECK(!rx_hello_stale(&S), "never on protocol 2");
    setup(1); feed("WEBADF 3 " KEY2 "\n"); drain(); CHECK(!rx_hello_stale(&S), "another key: READY 3 0 was right");
    CHECK_EQ_INT(rx_trust_now(&S), 0); CHECK(rx_hello_stale(&S), "trusted now: the board must hear READY 3 1");
}
static void a_lost_connection_forgets_the_request(void) {
    setup(1); vol("Work", "DH0:", 1, 1, 1); hello3(); drain();
    feed("VOLS v\n");
    rx_disconnected(&S);
    CHECK(!rx_want_output(&S), "nothing left to answer");
    rx_init(&S, &FS, on_ev, NULL); rx_attach(&S, &Q); hello3(); drain();
    CHECK(strcmp(ob, "READY 3 1\n") == 0, "a fresh connection starts clean");
}

int main(void) {
    RUN(a_protocol_3_hello_answers_ready_3_with_the_switch); RUN(another_boards_key_hears_browsing_off);
    RUN(requests_while_off_are_refused_off); RUN(malformed_requests_are_bad);
    RUN(volumes_are_listed_by_plain_name_duplicates_included); RUN(volumes_the_web_app_cannot_name_are_left_out);
    RUN(a_failed_volume_list_is_io); RUN(many_volumes_are_paced_by_the_buffer);
    RUN(a_second_request_while_one_waits_is_busy); RUN(a_changed_switch_makes_the_hello_stale_once_idle);
    RUN(a_lost_connection_forgets_the_request);
    return REPORT();
}
