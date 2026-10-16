#include <stdio.h>
#include <stdlib.h>
#include "harness.h"
#include "rx_crc.h"
#include "fakefs.h"

static fakefs F; static rx_fs FS; static rx_session S;
static rx_event last_ev[64]; static int n_ev; static char ev_text[64][300];
static void on_ev(void *u, const rx_event *e) {
    (void)u;
    last_ev[n_ev] = *e;
    snprintf(ev_text[n_ev], 300, "%s", e->kind == RX_EV_DONE || e->kind == RX_EV_FAILED ? (e->path ? e->path : "") : "");
    n_ev++;
}
static void setup(void) { ff_init(&F, &FS); n_ev = 0; rx_init(&S, &FS, on_ev, NULL); }
static int feed(const char *str) { return rx_feed(&S, (const unsigned char *)str, strlen(str)); }
static char outbuf[4096];
static const char *out(void) { unsigned n = rx_take_output(&S, outbuf, sizeof outbuf - 1); outbuf[n] = 0; return outbuf; }
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
    CHECK(strcmp(last_ev[n_ev - 1].text, "connection lost") == 0, "reason");
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
    CHECK(last_ev[0].text && strcmp(last_ev[0].text, "folder not found") == 0, "reason");
    CHECK(strcmp(ev_text[0], "Pic.iff") == 0, "path");
    setup(); F.free = 100; file_line(l, "r2", "x", 1, 0, "Big", "", 0); feed(l);
    CHECK_EQ_INT(n_ev, 1); CHECK(last_ev[0].text && strcmp(last_ev[0].text, "not enough space") == 0, "space reason");
}
static void huge_decimal_refused(void) {
    /* 4294967296 wrapped to 0 and the next bytes were read as commands (review minor). */
    setup(); feed("FILE w1 4294967296 0 0 1:x 0:\n");
    CHECK(strncmp(out(), "ERR w1 ", 7) == 0, "refused");
}
int main(void) {
    RUN(hello_and_ping); RUN(list_items); RUN(list_split_across_feeds_and_bad_line_skipped); RUN(one_file);
    RUN(line_and_data_in_one_feed_then_next_line); RUN(collision); RUN(subfolder_made); RUN(bad_crc);
    RUN(refusals); RUN(write_failure_consumes_data); RUN(zero_length); RUN(meta_and_comment);
    RUN(disconnect_mid_file); RUN(garbage_ignored_overflow_closes); RUN(progress_every_16k);
    RUN(long_path_keeps_comment); RUN(refusals_are_events); RUN(huge_decimal_refused);
    return REPORT();
}
