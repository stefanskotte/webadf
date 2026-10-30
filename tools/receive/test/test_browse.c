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

static void a_drawer_lists_each_entry_then_done(void) {
    setup(1); F.days = 10; F.mins = 20; F.ticks = 30;
    ff_add(&F, "Work:", 1); ff_add(&F, "Work:Programs", 1);
    ff_put(&F, "Work:Programs/a.txt", "hello", 5, 0x40, "note"); ff_add(&F, "Work:Programs/Sub", 1);
    hello3(); drain();
    feed("DIR d1 13:Work:Programs\n"); drain();
    CHECK(strcmp(ob, "ENT d1 f 5 40 10.20.30 5:a.txt 4:note\nENT d1 d 0 0 10.20.30 3:Sub 0:\nDONE d1 2\n") == 0, ob);
    CHECK_EQ_INT(F.dir_opens, 1); CHECK_EQ_INT(F.dir_closes, 1); CHECK(!F.dir_open, "the lock is let go");
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_code[i], "dir") == 0 && strcmp(ev_path[i], "Work:Programs") == 0 && ev[i].size == 2 && !ev_has_text[i], "the owner sees it"); }
}
static void a_volume_root_lists(void) {
    setup(1); ff_add(&F, "Work:", 1); ff_add(&F, "Work:Programs", 1); ff_put(&F, "Work:Programs/a.txt", "x", 1, 0, "");
    hello3(); drain(); feed("DIR d2 5:Work:\n"); drain();
    CHECK(strcmp(ob, "ENT d2 d 0 0 0.0.0 8:Programs 0:\nDONE d2 1\n") == 0, ob);
}
static void a_long_drawer_is_paced_and_nothing_is_lost(void) {
    static char b[RX_UP_BLOCK + 1]; int k, n = 0, pass = 0;
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 600;
    hello3(); drain();
    feed("DIR d3 8:Work:Big\n");
    ob_n = 0; ob[0] = 0; max_take = 0;
    while (rx_want_output(&S) && pass < 100000) {
        k = rx_take_output(&S, b, sizeof b - 1);
        if (k < 0) break;
        if (k > max_take) max_take = k;
        memcpy(ob + ob_n, b, (size_t)k); ob_n += (unsigned)k; ob[ob_n] = 0;
        if (++pass == 3) { CHECK(F.dir_open, "the drawer stays locked across passes"); feed("PING\n"); n++; }
    }
    CHECK_EQ_INT(n, 1);
    CHECK_EQ_INT(lines_starting("ENT d3 f "), 600);
    CHECK_EQ_INT(lines_starting("PONG"), 1);
    CHECK(strstr(ob, "ENT d3 f 0 0 0.0.0 5:f0000 0:\n") != NULL, "the first");
    CHECK(strstr(ob, "ENT d3 f 299 0 0.0.0 5:f0299 0:\nENT d3 f 300 0 0.0.0 5:f0300 0:\n") != NULL ||
          strstr(ob, "ENT d3 f 299 0 0.0.0 5:f0299 0:\nPONG\nENT d3 f 300 0 0.0.0 5:f0300 0:\n") != NULL, "in order");
    CHECK(ob_n >= 12 && strcmp(ob + ob_n - 12, "DONE d3 600\n") == 0, "DONE 600, last");
    CHECK(max_take <= RX_OUT_MAX, "never more than the 1 KB buffer at once");
    CHECK(!F.dir_open, "let go at the end");
}
static void the_listing_stops_at_1000_with_cut(void) {
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 1005;
    hello3(); drain(); feed("DIR d4 8:Work:Big\n"); drain();
    CHECK_EQ_INT(lines_starting("ENT d4 "), 1000);
    CHECK(ob_n > 17 && strcmp(ob + ob_n - 17, "DONE d4 1000 cut\n") == 0, "DONE 1000 cut, last");
    CHECK_EQ_INT(F.dir_closes, 1);
    { int i = last_req(); CHECK(i >= 0 && ev[i].bytes == 1 && ev[i].size == 1000, "cut, for the owner"); }
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 1000;
    hello3(); drain(); feed("DIR d5 8:Work:Big\n"); drain();
    CHECK(ob_n > 13 && strcmp(ob + ob_n - 13, "DONE d5 1000\n") == 0, "exactly 1000: not cut");
}
static void names_the_web_app_cannot_take_are_left_out_of_a_drawer(void) {
    setup(1); ff_add(&F, "Work:D", 1); ff_put(&F, "Work:D/ok", "x", 1, 0, "");
    ff_put(&F, "Work:D/bad\x01name", "x", 1, 0, ""); ff_put(&F, "Work:D/1234567890123456789012345678901", "x", 1, 0, "");
    hello3(); drain(); feed("DIR d6 6:Work:D\n"); drain();
    CHECK(strcmp(ob, "ENT d6 f 1 0 0.0.0 2:ok 0:\nDONE d6 1\n") == 0, ob);
}
static void latin1_names_go_out_byte_for_byte(void) {
    setup(1); ff_add(&F, "Gr\xfc\xdf" "e:", 1); ff_put(&F, "Gr\xfc\xdf" "e:Caf\xe9", "x", 1, 0, "\xe9t\xe9");
    hello3(); drain(); feed("DIR d7 6:Gr\xfc\xdf" "e:\n"); drain();
    CHECK(strcmp(ob, "ENT d7 f 1 0 0.0.0 4:Caf\xe9 3:\xe9t\xe9\nDONE d7 1\n") == 0, ob);
}
static void comments_lose_control_bytes(void) {
    setup(1); ff_add(&F, "Work:", 1); ff_put(&F, "Work:a", "x", 1, 0, "a\nb");
    hello3(); drain(); feed("DIR d8 5:Work:\n"); drain();
    CHECK(strcmp(ob, "ENT d8 f 1 0 0.0.0 1:a 3:a b\nDONE d8 1\n") == 0, ob);
}
static void drawer_errors_carry_amigados_words(void) {
    setup(1); ff_put(&F, "Work:a.txt", "x", 1, 0, ""); hello3(); drain();
    feed("DIR e1 9:Work:Nope\n"); drain(); CHECK(strcmp(ob, "ERR e1 notfound 13:dos error 205\n") == 0, ob);
    feed("DIR e2 10:Work:a.txt\n"); drain(); CHECK(strcmp(ob, "ERR e2 notdir 13:dos error 212\n") == 0, ob);
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_text[i], "dos error 212") == 0, "the owner sees AmigaDOS's words"); }
    CHECK(strcmp(rx_err_code(205, 1), "notfound") == 0, "205"); CHECK(strcmp(rx_err_code(204, 1), "notfound") == 0, "204");
    CHECK(strcmp(rx_err_code(202, 1), "busy") == 0, "202"); CHECK(strcmp(rx_err_code(224, 0), "denied") == 0, "224");
    CHECK(strcmp(rx_err_code(212, 1), "notdir") == 0, "212 dir"); CHECK(strcmp(rx_err_code(212, 0), "isdir") == 0, "212 get");
    CHECK(strcmp(rx_err_code(226, 1), "io") == 0, "226 no disk"); CHECK(strcmp(rx_err_code(218, 1), "io") == 0, "218 not mounted");
    CHECK(strcmp(rx_err_code(103, 1), "io") == 0, "103");
}
static void a_drawer_that_fails_mid_listing_ends_with_err_and_lets_go(void) {
    setup(1); strcpy(F.synth, "DF0:"); F.synth_n = 50; F.dir_fail_after = 2;
    hello3(); drain(); feed("DIR e3 4:DF0:\n"); drain();
    CHECK(strcmp(ob, "ENT e3 f 0 0 0.0.0 5:f0000 0:\nENT e3 f 1 0 0.0.0 5:f0001 0:\nERR e3 io 13:dos error 226\n") == 0, ob);
    CHECK(!F.dir_open && F.dir_closes == 1, "let go");
}
static void malformed_and_off_dir_requests(void) {
    setup(1); hello3(); drain();
    feed("DIR r2 junk\n"); drain(); CHECK(strcmp(ob, "ERR r2 bad 11:bad request\n") == 0, ob);
    feed("DIR r3 3:abc\n"); drain(); CHECK(strcmp(ob, "ERR r3 bad 11:bad request\n") == 0, "no volume");
    feed("DIR r4 0:\n"); drain(); CHECK(strcmp(ob, "ERR r4 bad 11:bad request\n") == 0, "empty");
    feed("DIR r5 5:Work: x\n"); drain(); CHECK(strcmp(ob, "ERR r5 bad 11:bad request\n") == 0, "after the path");
    feed("DIR r6 6:Work:\x01\n"); drain(); CHECK(strcmp(ob, "ERR r6 bad 11:bad request\n") == 0, "a control byte");
    CHECK_EQ_INT(F.dir_opens, 0);
    setup(0); hello3(); drain();
    feed("DIR r7 5:Work:\n"); drain(); CHECK(strcmp(ob, "ERR r7 off 27:browsing is off in Transfer\n") == 0, ob);
}
static void a_lost_connection_mid_listing_releases_the_drawer(void) {
    static char b[RX_UP_BLOCK + 1];
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 600;
    hello3(); drain(); feed("DIR d9 8:Work:Big\n");
    CHECK(rx_take_output(&S, b, sizeof b) > 0, "a first part");
    CHECK(F.dir_open, "open mid-listing");
    rx_disconnected(&S);
    CHECK(!F.dir_open && F.dir_closes == 1, "let go");
    { int i = last_req(); CHECK(i >= 0 && strcmp(ev_text[i], "connection lost") == 0, "the owner sees why"); }
}
static void requests_go_before_queued_files(void) {
    setup(1); strcpy(F.synth, "Work:Big"); F.synth_n = 300; ff_put(&F, "DH0:Mine", "m", 1, 0, "");
    hello3(); drain();
    feed("DIR d10 8:Work:Big\n");
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:Mine", "Mine"), 1);
    drain();
    CHECK(strstr(ob, "PUT 1 ") != NULL && strstr(ob, "DONE d10 300\n") != NULL && strstr(ob, "PUT 1 ") > strstr(ob, "DONE d10 300\n"),
          "the listing first, then the owner's file");
}

int main(void) {
    RUN(a_protocol_3_hello_answers_ready_3_with_the_switch); RUN(another_boards_key_hears_browsing_off);
    RUN(requests_while_off_are_refused_off); RUN(malformed_requests_are_bad);
    RUN(volumes_are_listed_by_plain_name_duplicates_included); RUN(volumes_the_web_app_cannot_name_are_left_out);
    RUN(a_failed_volume_list_is_io); RUN(many_volumes_are_paced_by_the_buffer);
    RUN(a_second_request_while_one_waits_is_busy); RUN(a_changed_switch_makes_the_hello_stale_once_idle);
    RUN(a_lost_connection_forgets_the_request);
    RUN(a_drawer_lists_each_entry_then_done); RUN(a_volume_root_lists); RUN(a_long_drawer_is_paced_and_nothing_is_lost);
    RUN(the_listing_stops_at_1000_with_cut); RUN(names_the_web_app_cannot_take_are_left_out_of_a_drawer);
    RUN(latin1_names_go_out_byte_for_byte); RUN(comments_lose_control_bytes); RUN(drawer_errors_carry_amigados_words);
    RUN(a_drawer_that_fails_mid_listing_ends_with_err_and_lets_go); RUN(malformed_and_off_dir_requests);
    RUN(a_lost_connection_mid_listing_releases_the_drawer); RUN(requests_go_before_queued_files);
    return REPORT();
}
