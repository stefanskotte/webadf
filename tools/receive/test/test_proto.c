#include <stdio.h>
#include <stdlib.h>
#include "harness.h"
#include "rx_crc.h"
#include "fakefs.h"

static fakefs F; static rx_fs FS; static rx_session S;
static rx_event last_ev[64]; static int n_ev; static char ev_text[64][300], ev_code[64][20], ev_key[64][40], ev_path[64][300];
static void on_ev(void *u, const rx_event *e) {
    (void)u;
    if (n_ev >= 64) return;
    last_ev[n_ev] = *e;
    snprintf(ev_text[n_ev], 300, "%s", e->kind == RX_EV_DONE || e->kind == RX_EV_FAILED ? (e->path ? e->path : "") : "");
    snprintf(ev_code[n_ev], 20, "%s", e->code ? e->code : "");
    snprintf(ev_key[n_ev], 40, "%s", e->key ? e->key : "");
    snprintf(ev_path[n_ev], 300, "%s|%s", e->path ? e->path : "", e->text ? e->text : "");
    last_ev[n_ev].text = NULL; last_ev[n_ev].code = NULL; last_ev[n_ev].key = NULL; last_ev[n_ev].path = NULL;
    n_ev++;
}
static void setup(void) { ff_init(&F, &FS); n_ev = 0; rx_init(&S, &FS, on_ev, NULL); }
static int feed(const char *str) { return rx_feed(&S, (const unsigned char *)str, strlen(str)); }
static char outbuf[4096];
static const char *out(void) { int n = rx_take_output(&S, outbuf, sizeof outbuf - 1); outbuf[n > 0 ? n : 0] = 0; return outbuf; }
static void file_line(char *dst, const char *id, const char *data, unsigned long len, unsigned long prot,
                      const char *path, const char *comment, int bad_crc) {
    unsigned long crc = rx_crc32_update(0, (const unsigned char *)data, len) ^ (bad_crc ? 1UL : 0UL);
    sprintf(dst, "FILE %s %lu %lx %lx %u:%s %u:%s\n", id, len, crc, prot, (unsigned)strlen(path), path,
            (unsigned)strlen(comment), comment);
}
static int has(const char *name) { return ff_find(&F, name) >= 0; }

static void hello_and_ping(void) {
    setup();
    feed("WEBADF 1\n"); CHECK(strcmp(out(), "READY 1\n") == 0, "READY");
    CHECK_EQ_INT(last_ev[0].kind, RX_EV_HELLO);
    feed("PING\r\n"); CHECK(strcmp(out(), "PONG\n") == 0, "PONG, CR dropped");
}
static void list_items(void) {
    setup();
    feed("LIST 2\na1 412000 13:Turrican2.lha\nb2 58000 14:mods/axelf.mod\n");
    CHECK_EQ_INT(S.list_n, 2);
    CHECK(strcmp(S.list[1].path, "mods/axelf.mod") == 0, "path"); CHECK_EQ_INT(S.list[0].size, 412000);
    CHECK_EQ_INT(last_ev[n_ev - 1].kind, RX_EV_LIST);
    feed("LIST 0\n"); CHECK_EQ_INT(S.list_n, 0);
}
static void list_split_across_feeds_and_bad_line_skipped(void) {
    setup();
    feed("LIST 3\na1 5 3:a"); feed("bc\n../bad line\nc3 9 1:z\n");
    CHECK_EQ_INT(S.list_n, 2); CHECK(strcmp(S.list[0].path, "abc") == 0, "split");
}
static void one_file(void) {
    char l[600]; setup();
    file_line(l, "a1", "hello", 5, 0, "Hello.txt", "", 0);
    feed(l); CHECK(strcmp(out(), "GO a1\n") == 0, "GO");
    CHECK(rx_busy(&S), "busy while receiving");
    feed("hel"); feed("lo");
    CHECK(strcmp(out(), "OK a1 9:Hello.txt\n") == 0, "OK");
    CHECK(has("Hello.txt") && !has(RX_TMP_NAME), "renamed, temp gone");
    CHECK(memcmp(F.e[ff_find(&F, "Hello.txt")].data, "hello", 5) == 0, "content");
    CHECK(!rx_busy(&S), "idle after");
    CHECK_EQ_INT(last_ev[n_ev - 1].kind, RX_EV_DONE);
}
static void line_and_data_in_one_feed_then_next_line(void) {
    char l[700]; setup();
    file_line(l, "a1", "hi", 2, 0, "X", "", 0); strcat(l, "hiPING\n");
    feed(l); CHECK(strcmp(out(), "GO a1\nOK a1 1:X\nPONG\n") == 0, "all three replies");
}
static void collision(void) {
    char l[600]; setup(); ff_add(&F, "Hello.txt", 0); ff_add(&F, "Hello_2.txt", 0);
    file_line(l, "a2", "x", 1, 0, "Hello.txt", "", 0); feed(l); feed("x");
    CHECK(strstr(out(), "OK a2 11:Hello_3.txt\n") != NULL, "third candidate");
}
static void subfolder_made(void) {
    char l[600]; setup();
    file_line(l, "b1", "m", 1, 0, "mods/new/axelf.mod", "", 0); feed(l); feed("m");
    CHECK(has("mods") && has("mods/new") && has("mods/new/axelf.mod"), "folders and file");
    CHECK(!has("mods/new/" RX_TMP_NAME), "temp in the target folder is gone");
}
static void bad_crc(void) {
    char l[600]; setup();
    file_line(l, "c1", "abc", 3, 0, "Bad.bin", "", 1); feed(l); feed("abc");
    CHECK(strstr(out(), "ERR c1 crc checksum mismatch\n") != NULL, "crc error");
    CHECK(!has("Bad.bin") && !has(RX_TMP_NAME), "nothing left");
    CHECK_EQ_INT(last_ev[n_ev - 1].kind, RX_EV_FAILED);
}
static void refusals(void) {
    char l[600];
    setup(); file_line(l, "d1", "x", 1, 0, "../x", "", 0); feed(l);
    CHECK(strcmp(out(), "ERR d1 name bad name\n") == 0, "bad name");
    setup(); F.folder_present = 0; file_line(l, "d2", "x", 1, 0, "x", "", 0); feed(l);
    CHECK(strcmp(out(), "ERR d2 folder folder not found\n") == 0, "folder");
    setup(); F.free = 8192; file_line(l, "d3", "x", 1, 0, "x", "", 0); feed(l);
    CHECK(strcmp(out(), "ERR d3 space not enough space\n") == 0, "space");
    setup(); feed("FILE d4 4194305 0 0 1:x 0:\n");
    CHECK(strcmp(out(), "ERR d4 size file too large\n") == 0, "size");
    setup(); feed("FILE d5 zz 0 0 1:x 0:\n");
    CHECK(strcmp(out(), "ERR d5 name bad request\n") == 0, "malformed");
    setup(); F.fail_make_dir = 1; file_line(l, "d6", "x", 1, 0, "a/x", "", 0); feed(l);
    CHECK(strcmp(out(), "ERR d6 write cannot create folder\n") == 0, "mkdir");
    /* After a refusal the receiver is idle and takes the next file. */
    setup(); file_line(l, "d7", "x", 1, 0, "../x", "", 0); feed(l); out();
    file_line(l, "d8", "y", 1, 0, "y", "", 0); feed(l); feed("y");
    CHECK(strstr(out(), "OK d8 1:y\n") != NULL, "next file after refusal");
}
static void write_failure_consumes_data(void) {
    char l[600]; setup(); F.fail_write_after = 2;
    file_line(l, "e1", "abcdef", 6, 0, "W", "", 0); feed(l); out();
    feed("abcdefPING\n");
    CHECK(strcmp(out(), "ERR e1 write cannot write\nPONG\n") == 0, "error after all bytes, then next line");
    CHECK(!has("W") && !has(RX_TMP_NAME), "removed");
}
static void zero_length(void) {
    setup(); feed("FILE f1 0 0 0 5:Empty 0:\n");
    CHECK(strcmp(out(), "GO f1\nOK f1 5:Empty\n") == 0, "GO then OK at once");
    CHECK(has("Empty"), "file");
}
static void meta_and_comment(void) {
    char l[600]; setup();
    file_line(l, "g1", "x", 1, 0x40, "Script", "a comment with spaces", 0); feed(l); feed("x");
    int i = ff_find(&F, "Script");
    CHECK(i >= 0 && F.e[i].prot == 0x40, "protection");
    CHECK(i >= 0 && strcmp(F.e[i].comment, "a comment with spaces") == 0, "comment");
    char longc[100]; memset(longc, 'c', 99); longc[99] = 0;
    setup(); file_line(l, "g2", "x", 1, 0, "C", longc, 0); feed(l); feed("x");
    i = ff_find(&F, "C"); CHECK(i >= 0 && strlen(F.e[i].comment) == RX_COMMENT_MAX, "comment cut to 79");
}
static void disconnect_mid_file(void) {
    char l[600]; setup();
    file_line(l, "h1", "abcdef", 6, 0, "D", "", 0); feed(l); out(); feed("abc");
    rx_disconnected(&S);
    CHECK(!has(RX_TMP_NAME) && !has("D"), "temp removed");
    CHECK_EQ_INT(last_ev[n_ev - 1].kind, RX_EV_FAILED);
    CHECK(strstr(ev_path[n_ev - 1], "|connection lost") != NULL, "reason");
    CHECK(!rx_busy(&S), "idle");
}
static void garbage_ignored_overflow_closes(void) {
    setup();
    CHECK_EQ_INT(feed("GET / HTTP/1.0\r\n\r\n"), 0); CHECK(strcmp(out(), "") == 0, "no reply to junk");
    feed("WEBADF 1\n"); CHECK(strcmp(out(), "READY 1\n") == 0, "still works");
    char big[700]; memset(big, 'x', 699); big[699] = 0;
    CHECK_EQ_INT(feed(big), -1);
}
static void progress_every_16k(void) {
    static unsigned char d[40000]; char l[600]; setup();
    for (int i = 0; i < 40000; i++) d[i] = (unsigned char)i;
    F.e[0].len = 0;
    unsigned long crc = rx_crc32_update(0, d, sizeof d);
    sprintf(l, "FILE p1 40000 %lx 0 1:P 0:\n", crc);
    feed(l); out(); n_ev = 0;
    rx_feed(&S, d, sizeof d);
    int prog = 0; for (int i = 0; i < n_ev; i++) if (last_ev[i].kind == RX_EV_PROGRESS) prog++;
    CHECK_EQ_INT(prog, 2);
    CHECK(strstr(out(), "OK p1 1:P\n") != NULL, "ok");
}

static void long_path_keeps_comment(void) {
    /* A 248-byte parent folder + ".webadf-rx" did not fit cur_tmp and overwrote the comment (review finding 3). */
    char path[260], l[700]; int k = 0;
    for (int part = 0; part < 8; part++) { memset(path + k, 'a' + part, 30); k += 30; path[k++] = '/'; }
    path[k++] = 'x'; path[k] = 0;                               /* 8 * 31 + 1 = 249 bytes */
    setup();
    file_line(l, "t1", "x", 1, 0, path, "keep me", 0); feed(l); feed("x");
    const char *o = out();
    CHECK(strstr(o, "OK t1 ") != NULL, "saved");
    int i = ff_find(&F, path);
    CHECK(i >= 0 && strcmp(F.e[i].comment, "keep me") == 0, "comment intact");
}
static void refusals_are_events(void) {
    /* The person at the Amiga must see why a file did not arrive (review finding 4). */
    char l[600];
    setup(); F.folder_present = 0; file_line(l, "r1", "x", 1, 0, "Pic.iff", "", 0); feed(l);
    CHECK_EQ_INT(n_ev, 1);
    CHECK_EQ_INT(last_ev[0].kind, RX_EV_FAILED);
    CHECK(strstr(ev_path[0], "|folder not found") != NULL, "reason");
    CHECK(strcmp(ev_text[0], "Pic.iff") == 0, "path");
    setup(); F.free = 100; file_line(l, "r2", "x", 1, 0, "Big", "", 0); feed(l);
    CHECK_EQ_INT(n_ev, 1); CHECK(strstr(ev_path[0], "|not enough space") != NULL, "space reason");
}
static void huge_decimal_refused(void) {
    /* 4294967296 wrapped to 0 and the next bytes were read as commands (review minor). */
    setup(); feed("FILE w1 4294967296 0 0 1:x 0:\n");
    CHECK(strncmp(out(), "ERR w1 ", 7) == 0, "refused");
}
/* --- protocol 2 (spec 2026-10-18 §3, §6) --- */
static rx_upq Q;
static const char *KEY = "0123456789abcdef0123456789abcdef";
static const char *KEY2 = "fedcba9876543210fedcba9876543210";
static void setup2(const char *trusted) { setup(); rx_upq_init(&Q, trusted); rx_attach(&S, &Q); }
static int last_kind(int k) { for (int i = n_ev - 1; i >= 0; i--) if (last_ev[i].kind == k) return i; return -1; }
static void hello2(const char *key) { char l[80]; snprintf(l, sizeof l, "WEBADF 2 %s\n", key); feed(l); }
static const char *trust_code(void) { int i = last_kind(RX_EV_TRUST); return i < 0 ? "" : ev_code[i]; }
static unsigned added_n; static char added_names[80][300];
static void on_added(void *u, const rx_up_item *it) { (void)u; snprintf(added_names[added_n++ % 80], 300, "%s=%s", it->name, it->local); }

static void v2_hello_answers_ready_2_and_trusts_the_first_key(void) {
    setup2("");
    hello2(KEY);
    CHECK(strcmp(out(), "READY 2\n") == 0, "READY 2");
    CHECK(strcmp(trust_code(), "new") == 0, "a new key");
    CHECK(strcmp(ev_key[last_kind(RX_EV_TRUST)], KEY) == 0, "the key in the event");
    CHECK(strcmp(Q.trusted, KEY) == 0, "saved");
    CHECK(rx_uploads_on(&S), "uploads on");
    CHECK(last_kind(RX_EV_HELLO) >= 0 && last_kind(RX_EV_HELLO) < last_kind(RX_EV_TRUST), "HELLO, then TRUST");
}
static void the_same_key_again_is_ok_and_another_is_refused(void) {
    setup2(KEY); hello2(KEY); out();
    CHECK(strcmp(trust_code(), "ok") == 0, "ok"); CHECK(rx_uploads_on(&S), "on");
    setup2(KEY); hello2(KEY2); out();
    CHECK(strcmp(trust_code(), "other") == 0, "other");
    CHECK(!rx_uploads_on(&S), "uploads off"); CHECK(strcmp(Q.trusted, KEY) == 0, "the saved key is unchanged");
    setup2(KEY); hello2("0123456789ABCDEF0123456789ABCDEF"); out();
    CHECK(strcmp(trust_code(), "ok") == 0, "upper-case hex is the same key");
}
static void a_malformed_key_is_never_saved(void) {
    setup2(""); feed("WEBADF 2 xyz\n");
    CHECK(strcmp(out(), "READY 2\n") == 0, "still READY 2: downloads keep working");
    CHECK(strcmp(trust_code(), "other") == 0, "not trusted"); CHECK(Q.trusted[0] == 0, "nothing saved");
    setup2(""); feed("WEBADF 2\n"); out();
    CHECK(strcmp(trust_code(), "other") == 0, "no key at all");
}
static void a_protocol_1_board_is_old_and_uploads_stay_off(void) {
    setup2(""); feed("WEBADF 1\n");
    CHECK(strcmp(out(), "READY 1\n") == 0, "READY 1");
    CHECK(strcmp(trust_code(), "old") == 0, "old"); CHECK(!rx_uploads_on(&S), "off"); CHECK(Q.trusted[0] == 0, "nothing saved");
    setup(); feed("WEBADF 2 "); feed(KEY); feed("\n");
    CHECK(strcmp(out(), "READY 2\n") == 0, "no queue attached: READY 2, no trust event");
    CHECK_EQ_INT(last_kind(RX_EV_TRUST), -1);
}
static void trust_now_and_trust_next_replace_the_saved_key(void) {
    char k4[5];
    setup2(KEY); hello2(KEY2); out();
    CHECK_EQ_INT(rx_trust_now(&S), 0);
    CHECK(strcmp(Q.trusted, KEY2) == 0, "replaced"); CHECK(rx_uploads_on(&S), "on"); CHECK(strcmp(trust_code(), "new") == 0, "saved again");
    setup2(KEY); CHECK_EQ_INT(rx_trust_now(&S), -1);   /* no board yet */
    Q.trust_next = 1; hello2(KEY2); out();
    CHECK(strcmp(Q.trusted, KEY2) == 0, "the next board's key"); CHECK_EQ_INT(Q.trust_next, 0);
    rx_key4(KEY2, k4); CHECK(strcmp(k4, "FEDC") == 0, "four digits, upper case");
}
static void the_queue_takes_64_good_names(void) {
    char nm[20];
    rx_upq_init(&Q, "");
    for (int i = 0; i < RX_UP_MAX; i++) { snprintf(nm, sizeof nm, "F%d", i); CHECK_EQ_INT(rx_up_add(&Q, "DH0:f", nm), i + 1); }
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:f", "one-more"), 0);
    CHECK_EQ_INT(rx_upq_remove(&Q, 3), 1); CHECK_EQ_INT(Q.n, RX_UP_MAX - 1); CHECK_EQ_INT(rx_upq_remove(&Q, 3), 0);
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:x", "../x"), 0); CHECK_EQ_INT(rx_up_add(&Q, "DH0:x", "a:b"), 0);
    CHECK_EQ_INT(rx_up_add(&Q, "", "x"), 0);
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:x", "x"), RX_UP_MAX + 1);   /* tags keep counting */
}
static void a_dropped_drawer_is_walked_and_icons_skipped(void) {
    setup2(""); added_n = 0;
    ff_add(&F, "DH0:Mods", 1); ff_add(&F, "DH0:Mods/sub", 1);
    ff_put(&F, "DH0:Mods/a.mod", "a", 1, 0, ""); ff_put(&F, "DH0:Mods/a.mod.info", "i", 1, 0, "");
    ff_put(&F, "DH0:Mods/sub/b.mod", "b", 1, 0, "");
    CHECK_EQ_INT(rx_up_add_tree(&Q, &FS, "DH0:Mods", "Mods", on_added, NULL), 2);
    CHECK_EQ_INT(Q.n, 2);
    CHECK((strcmp(added_names[0], "Mods/a.mod=DH0:Mods/a.mod") == 0 && strcmp(added_names[1], "Mods/sub/b.mod=DH0:Mods/sub/b.mod") == 0) ||
          (strcmp(added_names[1], "Mods/a.mod=DH0:Mods/a.mod") == 0 && strcmp(added_names[0], "Mods/sub/b.mod=DH0:Mods/sub/b.mod") == 0),
          "both files, with their sub-paths; the icon file skipped");
    CHECK_EQ_INT(rx_up_add_tree(&Q, &FS, "DH0:Mods/a.mod.info", "a.mod.info", NULL, NULL), 1);   /* an icon dropped itself goes */
    CHECK_EQ_INT(rx_up_add_tree(&Q, &FS, "DH0:Nothing", "Nothing", NULL, NULL), -1);
}
static void a_volume_root_joins_without_a_slash_and_a_walk_stops_at_64(void) {
    char nm[40];
    setup2(""); ff_add(&F, "RAM:", 1);
    for (int i = 0; i < 70; i++) { snprintf(nm, sizeof nm, "RAM:f%02d", i); ff_put(&F, nm, "x", 1, 0, ""); }
    CHECK_EQ_INT(rx_up_add_tree(&Q, &FS, "RAM:", "Ram Disk", NULL, NULL), RX_UP_MAX);
    CHECK(strncmp(Q.q[0].local, "RAM:f", 5) == 0 && strncmp(Q.q[0].name, "Ram Disk/f", 10) == 0, "RAM:fNN, Ram Disk/fNN");
}
/* --- protocol 2: a file going up --- */
static unsigned char DATA[65536];
static unsigned char obig[200000]; static unsigned long ob_n; static int ob_closed;
static void fill_data(void) { for (unsigned i = 0; i < sizeof DATA; i++) DATA[i] = (unsigned char)(i * 7 + 3); }
/* Everything Receive has to send now, in 4 KB takes, as a front end does. */
static void drain(void) {
    ob_n = 0; ob_closed = 0;
    for (int i = 0; i < 5000 && rx_want_output(&S); i++) {
        int k = rx_take_output(&S, (char *)obig + ob_n, 4096);
        if (k < 0) { ob_closed = 1; break; }
        ob_n += (unsigned long)k;
    }
    obig[ob_n] = 0;
}
static void up_ready(const char *local, const char *name, unsigned long len, unsigned long prot, const char *comment) {
    setup2(""); fill_data(); F.days = 1; F.mins = 2; F.ticks = 3;
    ff_put(&F, local, DATA, len, prot, comment);
    rx_up_add(&Q, local, name);
    hello2(KEY); out();          /* READY 2 (the PUT is not out yet: out() takes lines only once) */
}
static unsigned long crc_of(unsigned long n) { return rx_crc32_update(0, DATA, n); }

static void put_goes_out_once_the_board_is_trusted(void) {
    setup2(""); fill_data(); F.days = 1; F.mins = 2; F.ticks = 3;
    ff_put(&F, "DH0:Hello.txt", "hello", 5, 0x40, "note");
    CHECK_EQ_INT(rx_up_add(&Q, "DH0:Hello.txt", "Hello.txt"), 1);
    drain(); CHECK_EQ_INT(ob_n, 0);                       /* no board yet */
    hello2(KEY); drain();
    CHECK(strcmp((char *)obig, "READY 2\nPUT 1 5 1.2.3 40 9:Hello.txt 4:note\n") == 0, "READY, then the PUT");
    CHECK_EQ_INT(Q.n, 0); CHECK_EQ_INT(F.opens_r, 1);
    CHECK_EQ_INT(rx_idle_secs(&S), RX_UP_IDLE_SECS);
}
static void no_put_while_a_file_comes_down(void) {
    char l[600];
    setup2(""); ff_put(&F, "DH0:a", "a", 1, 0, ""); hello2(KEY); out();
    file_line(l, "d1", "hello", 5, 0, "Down.txt", "", 0); feed(l);
    rx_up_add(&Q, "DH0:a", "a");
    drain(); CHECK(strstr((char *)obig, "GO d1\n") && !strstr((char *)obig, "PUT"), "no PUT while receiving");
    feed("hello"); drain();
    CHECK(strstr((char *)obig, "OK d1 8:Down.txt\nPUT 1 1 ") != NULL, "the OK, then the PUT");
}
static void no_put_to_a_protocol_1_board_or_another_key(void) {
    setup2(""); ff_put(&F, "DH0:a", "a", 1, 0, ""); rx_up_add(&Q, "DH0:a", "a");
    feed("WEBADF 1\n"); drain(); CHECK(strstr((char *)obig, "PUT") == NULL, "protocol 1: no PUT");
    setup2(KEY); ff_put(&F, "DH0:a", "a", 1, 0, ""); rx_up_add(&Q, "DH0:a", "a");
    hello2(KEY2); drain(); CHECK(strstr((char *)obig, "PUT") == NULL, "another key: no PUT");
    CHECK_EQ_INT(Q.n, 1);                                 /* it waits for the trusted board */
}
static void bytes_never_pass_the_credit_then_end(void) {
    char want[40];
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();   /* the PUT */
    feed("TAKE 1 0 32768\n"); drain();
    CHECK_EQ_INT(ob_n, 32768); CHECK(memcmp(obig, DATA, 32768) == 0, "the first 32 KB");
    CHECK(!rx_want_output(&S), "nothing past the credit");
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_BEGIN)].bytes, 0);
    feed("MORE 1 40000 32768\n"); drain();
    snprintf(want, sizeof want, "END 1 %lx\n", crc_of(40000));
    CHECK_EQ_INT(ob_n, 7232 + strlen(want));
    CHECK(memcmp(obig, DATA + 32768, 7232) == 0, "the rest");
    CHECK(strcmp((char *)obig + 7232, want) == 0, "END with the CRC of the whole file");
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_PROGRESS)].bytes, 32768);   /* the board's stored field */
}
static void resume_crc_covers_the_skipped_part(void) {
    char want[40];
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    feed("TAKE 1 16384 40000\n"); drain();
    snprintf(want, sizeof want, "END 1 %lx\n", crc_of(40000));
    CHECK_EQ_INT(ob_n, 40000 - 16384 + strlen(want));
    CHECK(memcmp(obig, DATA + 16384, 40000 - 16384) == 0, "only the part the web app lacks is sent");
    CHECK(strcmp((char *)obig + 40000 - 16384, want) == 0, "the CRC still covers the whole file");
    CHECK_EQ_INT(F.bytes_read, 40000);                    /* the skipped part is read once, never sent */
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_BEGIN)].bytes, 16384);
}
static void resume_at_the_end_sends_no_bytes_then_end(void) {   /* Review Focus 1 */
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, ""); drain();
    feed("TAKE 1 5 5\n"); drain();
    char want[40]; snprintf(want, sizeof want, "END 1 %lx\n", crc_of(5));
    CHECK(strcmp((char *)obig, want) == 0, "END at once");
    CHECK_EQ_INT(F.bytes_read, 5);
}
static void empty_file_goes_up(void) {                          /* Review Focus 2 */
    up_ready("RAM:Empty", "Empty", 0, 0, ""); drain();
    CHECK(strcmp((char *)obig, "PUT 1 0 1.2.3 0 5:Empty 0:\n") == 0, "PUT size 0");
    feed("TAKE 1 0 0\n"); drain();
    CHECK(strcmp((char *)obig, "END 1 0\n") == 0, "END 1 0");
}
static void done_and_no_are_events_and_the_next_file_follows(void) {
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, "");
    ff_put(&F, "DH0:Two", "two", 3, 0, ""); rx_up_add(&Q, "DH0:Two", "Two");
    drain(); feed("TAKE 1 0 5\n"); drain();
    feed("DONE 1 9:Hello.txt\n");
    int i = last_kind(RX_EV_UP_DONE);
    CHECK(i >= 0 && last_ev[i].tag == 1 && strncmp(ev_path[i], "Hello.txt|", 10) == 0, "done, with the stored name");
    CHECK_EQ_INT(F.closes_r, 1);
    drain(); CHECK(strncmp((char *)obig, "PUT 2 3 ", 8) == 0, "the next file");
    feed("NO 2 full 23:the area on the web app\n");
    i = last_kind(RX_EV_UP_FAILED);
    CHECK(i >= 0 && strcmp(ev_code[i], "full") == 0 && strstr(ev_path[i], "|the area on the web app"), "refused, with the board's words");
    CHECK_EQ_INT(F.closes_r, 2);
}
static void abort_before_take_and_cancel_mid_file(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    CHECK_EQ_INT(rx_up_cancel(&S, &Q, 1), 0);
    drain(); CHECK(strcmp((char *)obig, "ABORT 1\n") == 0, "ABORT before TAKE");
    feed("NO 1 busy 9:cancelled\n");
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "|cancelled") != NULL, "cancelled");
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n");
    CHECK_EQ_INT(rx_up_cancel(&S, &Q, 1), 1);             /* mid-file: only closing stops it (ruling P7) */
    drain(); CHECK(ob_closed, "the connection closes");
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    feed("TAKE 1 0 32768\n");
    rx_up_add(&Q, "DH0:Big", "Big");
    CHECK_EQ_INT(rx_up_cancel(&S, &Q, 2), 0); CHECK_EQ_INT(Q.n, 0);   /* a waiting one just leaves the list */
    CHECK_EQ_INT(rx_up_cancel(&S, &Q, 99), -1);
}
static void take_after_abort_closes(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    rx_up_cancel(&S, &Q, 1); drain();                      /* ABORT out, but TAKE was already on its way */
    feed("TAKE 1 0 32768\n"); drain();
    CHECK(ob_closed, "closed: the board already treats every byte as data");
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "|cancelled") != NULL, "cancelled");
}
static void a_read_failure_mid_file_closes(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    F.fail_read_at = 10000;
    feed("TAKE 1 0 32768\n"); drain();
    CHECK(ob_closed, "closed");
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "|cannot read the file") != NULL, "why");
}
static void a_dropped_connection_fails_the_file(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n"); drain();
    rx_disconnected(&S);
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "|connection lost") != NULL, "connection lost");
    CHECK_EQ_INT(F.closes_r, 1); CHECK_EQ_INT(rx_idle_secs(&S), RX_IDLE_SECS);
}
static void answers_out_of_range_and_a_file_mid_upload_close(void) {
    char l[600];
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, ""); drain();
    CHECK_EQ_INT(feed("TAKE 1 6 5\n"), -1);
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, ""); drain();
    CHECK_EQ_INT(feed("TAKE 1 0 9\n"), -1);                /* a credit past the size */
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n");
    file_line(l, "d9", "x", 1, 0, "X", "", 0);
    CHECK_EQ_INT(feed(l), -1);
}
static void no_after_data_started_closes_too(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n");
    feed("NO 1 offline 29:the web app cannot be reached\n");
    CHECK(strcmp(ev_code[last_kind(RX_EV_UP_FAILED)], "offline") == 0, "offline");
    drain(); CHECK(ob_closed, "closed: the place in the stream is lost");
}
static void stale_lines_for_another_tag_are_ignored(void) {
    up_ready("DH0:Hello.txt", "Hello.txt", 5, 0, ""); drain();
    feed("TAKE 7 0 5\nMORE 7 5 5\nDONE 7 1:x\nNO 7 full 1:x\n");
    CHECK_EQ_INT(last_kind(RX_EV_UP_BEGIN), -1); CHECK_EQ_INT(last_kind(RX_EV_UP_FAILED), -1);
}
static void progress_follows_the_stored_field_and_a_capped_credit(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    feed("TAKE 1 0 32768\n"); drain();
    feed("MORE 1 40000 16384\n");                          /* credit capped at the size; stored is what counts */
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_PROGRESS)].bytes, 16384);
    feed("MORE 1 40000 40000\n");
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_PROGRESS)].bytes, 40000);
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    feed("TAKE 1 0 40000\n");                              /* a first TAKE already capped */
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_BEGIN)].bytes, 0);
    feed("MORE 1 40000 8192\n");
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_PROGRESS)].bytes, 8192);
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    CHECK_EQ_INT(feed("TAKE 1 0 32768\nMORE 1 40000\n"), -1);   /* no third field: a protocol error closes */
    CHECK(strstr(ev_path[last_kind(RX_EV_UP_FAILED)], "out of range") != NULL, "MORE without <stored> is refused");
}
static void a_drop_after_take_reports_the_stored_offset(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n"); drain();
    rx_disconnected(&S);
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_FAILED)].bytes, 0);   /* sent 32768, stored 0 */
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 16384 32768\n"); drain();
    rx_disconnected(&S);
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_FAILED)].bytes, 16384);
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    rx_disconnected(&S);
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_FAILED)].bytes, 0);   /* before any TAKE */
}
static void more_mid_write_and_during_skip_never_lets_sent_pass_credit(void) {
    unsigned char b[4096]; int k;
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    feed("TAKE 1 16384 24576\n");                          /* SKIP first */
    k = rx_take_output(&S, (char *)b, sizeof b);           /* one skip block, nothing sent */
    CHECK_EQ_INT(k, 0);
    feed("MORE 1 24576 16384\n");                          /* a MORE during SKIP */
    CHECK_EQ_INT(last_ev[last_kind(RX_EV_UP_PROGRESS)].bytes, 16384);
    drain();
    CHECK_EQ_INT(ob_n, 24576 - 16384); CHECK_EQ_INT(S.up_sent, 24576);
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 12288\n");
    for (int i = 0; i < 2; i++) { rx_take_output(&S, (char *)b, sizeof b); rx_take_output(&S, (char *)b, sizeof b); }   /* mid-write */
    feed("MORE 1 12288 4096\n");                           /* a MORE that does not raise the credit */
    drain(); CHECK(S.up_sent <= S.up_credit, "sent never passes credit"); CHECK_EQ_INT(S.up_sent, 12288);
    feed("MORE 1 20000 12288\n"); drain();
    CHECK(S.up_sent <= S.up_credit, "still within the credit"); CHECK_EQ_INT(S.up_sent, 20000);
}
static void the_comment_in_the_put_has_no_control_bytes(void) {
    up_ready("DH0:C", "C", 3, 0, "a\nb\rc\td"); drain();
    CHECK(strstr((char *)obig, "PUT 1 3 1.2.3 0 1:C 7:a b c d\n") != NULL, "control bytes become spaces, length kept");
    CHECK_EQ_INT(strchr(strstr((char *)obig, "PUT"), '\n') - (char *)obig, (long)strlen("PUT 1 3 1.2.3 0 1:C 7:a b c d"));
}
/* Increment-2 review, item 1: the CRC over a resume's stored part is Receive's own silent work -- the loop restarts its
   idle clock while it lasts (net.c), so a long pre-read on a 68000 never times the board out. */
static void a_resumes_pre_read_counts_as_receives_own_work(void) {
    unsigned char b[RX_UP_BLOCK];
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain();
    CHECK(!rx_up_reading_ahead(&S), "not before the TAKE");
    feed("TAKE 1 16384 24576\n");
    CHECK(rx_up_reading_ahead(&S), "reading the stored part");
    CHECK_EQ_INT(rx_take_output(&S, (char *)b, sizeof b), 0);
    CHECK(rx_up_reading_ahead(&S), "one block of two read");
    CHECK_EQ_INT(rx_take_output(&S, (char *)b, sizeof b), 0);
    CHECK(!rx_up_reading_ahead(&S), "done: the raw bytes are next, and the board answers them");
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 16384\n");
    CHECK(!rx_up_reading_ahead(&S), "no stored part, no pre-read");
}
/* Item 5: a file deleted on the web app mid-upload -- the board's NO gone, its text shown as sent. */
static void no_gone_mid_file_shows_the_boards_text(void) {
    up_ready("DH0:Big", "Big", 40000, 0, ""); drain(); feed("TAKE 1 0 32768\n");
    feed("NO 1 gone 22:deleted on the web app\n");
    int i = last_kind(RX_EV_UP_FAILED);
    CHECK(i >= 0 && strcmp(ev_code[i], "gone") == 0, "code gone");
    CHECK(i >= 0 && strcmp(ev_path[i], "Big|deleted on the web app") == 0, ev_path[i < 0 ? 0 : i]);
    drain(); CHECK(ob_closed, "closed: the place in the stream is lost");
}
int main(void) {
    RUN(hello_and_ping); RUN(list_items); RUN(list_split_across_feeds_and_bad_line_skipped); RUN(one_file);
    RUN(line_and_data_in_one_feed_then_next_line); RUN(collision); RUN(subfolder_made); RUN(bad_crc);
    RUN(refusals); RUN(write_failure_consumes_data); RUN(zero_length); RUN(meta_and_comment);
    RUN(disconnect_mid_file); RUN(garbage_ignored_overflow_closes); RUN(progress_every_16k);
    RUN(long_path_keeps_comment); RUN(refusals_are_events); RUN(huge_decimal_refused);
    RUN(v2_hello_answers_ready_2_and_trusts_the_first_key); RUN(the_same_key_again_is_ok_and_another_is_refused);
    RUN(a_malformed_key_is_never_saved); RUN(a_protocol_1_board_is_old_and_uploads_stay_off);
    RUN(trust_now_and_trust_next_replace_the_saved_key); RUN(the_queue_takes_64_good_names);
    RUN(a_dropped_drawer_is_walked_and_icons_skipped); RUN(a_volume_root_joins_without_a_slash_and_a_walk_stops_at_64);
    RUN(put_goes_out_once_the_board_is_trusted); RUN(no_put_while_a_file_comes_down);
    RUN(no_put_to_a_protocol_1_board_or_another_key); RUN(bytes_never_pass_the_credit_then_end);
    RUN(resume_crc_covers_the_skipped_part); RUN(resume_at_the_end_sends_no_bytes_then_end); RUN(empty_file_goes_up);
    RUN(done_and_no_are_events_and_the_next_file_follows); RUN(abort_before_take_and_cancel_mid_file);
    RUN(take_after_abort_closes); RUN(a_read_failure_mid_file_closes); RUN(a_dropped_connection_fails_the_file);
    RUN(answers_out_of_range_and_a_file_mid_upload_close); RUN(no_after_data_started_closes_too);
    RUN(stale_lines_for_another_tag_are_ignored); RUN(progress_follows_the_stored_field_and_a_capped_credit);
    RUN(a_drop_after_take_reports_the_stored_offset); RUN(more_mid_write_and_during_skip_never_lets_sent_pass_credit);
    RUN(the_comment_in_the_put_has_no_control_bytes);
    RUN(a_resumes_pre_read_counts_as_receives_own_work); RUN(no_gone_mid_file_shows_the_boards_text);
    return REPORT();
}
