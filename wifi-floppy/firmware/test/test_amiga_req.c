// amiga_req.c: NET: volumes' request state (spec 2026-10-30 section 3, fw 1.22.0).
#include <stdio.h>
#include <string.h>
#include "harness.h"
#include "../src/amiga_req.h"

static as_req_t R;
static void load(const char *text) { ar_init(&R); int n = (int)strlen(text); memcpy(R.fetched, text, (size_t)n); ar_fetched(&R, n); }

static void takes_vols_dir_and_get_in_order(void) {
    load("VOLS r1\nDIR r_2 5:Work:\nGET r-3 14:Work:Hello.txt\n");
    CHECK(ar_pending(&R), "pending");
    CHECK(ar_take(&R, NULL), "first");
    CHECK(R.kind == AR_VOLS && strcmp(R.rid, "r1") == 0, R.rid);
    CHECK(strcmp(R.out, "VOLS r1\n") == 0 && R.out_n == 8, R.out);
    CHECK(R.active && !R.sent && !R.ended && R.piece == 0, "fresh request");
    CHECK(strcmp(R.body, "{\"piece\":0,\"lines\":[") == 0, R.body);
    ar_finish(&R);
    CHECK(ar_take(&R, NULL) && R.kind == AR_DIR && strcmp(R.rid, "r_2") == 0, "DIR");
    CHECK(strcmp(R.out, "DIR r_2 5:Work:\n") == 0, R.out);
    ar_finish(&R);
    CHECK(ar_take(&R, NULL) && R.kind == AR_GET && strcmp(R.out, "GET r-3 14:Work:Hello.txt\n") == 0, R.out);
    ar_finish(&R);
    CHECK(!ar_pending(&R) && !ar_take(&R, NULL), "none left");
}

// The board checks the line's shape only; AmigaDOS syntax ("Work" without a colon) is Transfer's to refuse.
static void malformed_lines_are_skipped_and_counted(void) {
    load("POST x\nVOLS\nVOLS a b\nVOLS bad!id\nDIR d 9:Work:\nDIR d 0:\nDIR d 3:a\x01" "b\n"
         "VOLS 01234567890123456789012345678901234567890\nGET g 4:Work\nVOLS ok\n");
    int bad = 0;
    CHECK(ar_take(&R, &bad), "the first valid line is found");
    CHECK(strcmp(R.rid, "g") == 0, R.rid);
    CHECK_EQ_INT(bad, 8);
    ar_finish(&R);
    CHECK(ar_take(&R, &bad) && strcmp(R.rid, "ok") == 0, "then the next");
}

static void a_last_line_without_newline_still_counts(void) {
    load("VOLS a");
    CHECK(ar_take(&R, NULL) && strcmp(R.out, "VOLS a\n") == 0, R.out);
}

static void a_piece_is_json_with_latin1_escaped(void) {
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    CHECK(ar_body_add(&R, "ENT d f 5 0 1.0.0 5:Caf\xe9 0:"), "add");
    CHECK(ar_body_add(&R, "DONE d 1"), "add");
    ar_body_close(&R, true);
    CHECK(strcmp(R.body, "{\"piece\":0,\"lines\":[\"ENT d f 5 0 1.0.0 5:Caf\\u00e9 0:\",\"DONE d 1\"],\"last\":true}") == 0, R.body);
    CHECK(R.body_len == (int)strlen(R.body), "length");
    CHECK(R.post_owed && R.post_last && R.ended, "owed, last");
}

static void quotes_and_backslashes_are_escaped(void) {
    load("VOLS v\n"); ar_take(&R, NULL);
    ar_body_add(&R, "a\"b\\c"); ar_body_close(&R, false);
    CHECK(strcmp(R.body, "{\"piece\":0,\"lines\":[\"a\\\"b\\\\c\"],\"last\":false}") == 0, R.body);
    CHECK(R.post_owed && !R.post_last && !R.ended, "owed, not last");
}

static void full_leaves_room_for_any_line(void) {
    char line[AR_LINE_MAX + 1];
    memset(line, 0xe9, AR_LINE_MAX); line[AR_LINE_MAX] = 0;          // every byte an escape: the worst line
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    int added = 0;
    while (!ar_body_full(&R)) { CHECK(ar_body_add(&R, line), "a line always fits while not full"); added++; if (added > 100) break; }
    ar_body_close(&R, false);
    CHECK(R.body_len < AR_BODY_BYTES, "inside the buffer");
    CHECK(added >= 8 && added <= 9, "about 32 KB / 3843 bytes");
    CHECK(strcmp(R.body + R.body_len - 15, "],\"last\":false}") == 0, "closed");
}

static void a_piece_holds_at_most_400_lines(void) {
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    for (int i = 0; i < AR_PIECE_LINES; i++) CHECK(ar_body_add(&R, "x"), "fits");
    CHECK(ar_body_full(&R), "full at 400");
    CHECK(!ar_body_add(&R, "x"), "line 401 refused");
}

static void after_a_middle_piece_the_next_begins(void) {
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    ar_body_add(&R, "ENT d 1"); ar_body_close(&R, false);
    ar_body_posted(&R);
    CHECK(!R.post_owed && R.active && R.piece == 1, "piece 1");
    CHECK(strcmp(R.body, "{\"piece\":1,\"lines\":[") == 0, R.body);
    ar_body_add(&R, "DONE d 1"); ar_body_close(&R, true);
    ar_body_posted(&R);
    CHECK(!R.active && !R.post_owed && R.kind == AR_NONE, "finished");
}

static void end_err_while_a_piece_is_in_flight_goes_in_the_next(void) {
    load("DIR d 5:Work:\n"); ar_take(&R, NULL);
    ar_body_add(&R, "ENT d 1"); ar_body_close(&R, false);
    ar_end_err(&R, "norx", "The connection to Transfer was lost");
    CHECK(R.ended && R.post_owed && !R.post_last, "the piece in flight is unchanged");
    ar_body_posted(&R);
    CHECK(strcmp(R.body, "{\"piece\":1,\"lines\":[\"ERR d norx 35:The connection to Transfer was lost\"],\"last\":true}") == 0, R.body);
    CHECK(R.post_owed && R.post_last, "the ERR piece is owed, last");
    ar_end_err(&R, "timeout", "Transfer stopped answering");
    CHECK(strstr(R.body, "timeout") == NULL, "ended: a second end changes nothing");
}

static void end_err_with_room_closes_at_once(void) {
    load("VOLS v\n"); ar_take(&R, NULL);
    ar_end_err(&R, "norx", "Transfer is not running on the Amiga");
    CHECK(strcmp(R.body, "{\"piece\":0,\"lines\":[\"ERR v norx 36:Transfer is not running on the Amiga\"],\"last\":true}") == 0, R.body);
}

static void end_err_on_a_discarded_answer_just_finishes(void) {
    load("VOLS v\n"); ar_take(&R, NULL);
    R.discard = true;
    ar_end_err(&R, "norx", "x");
    CHECK(!R.active && !R.post_owed, "nothing more is posted");
}

static void err_line_cuts_the_text_at_79(void) {
    char t[120], out[AR_ERR_MAX + 1];
    memset(t, 'a', 100); t[100] = 0;
    int n = ar_err_line(out, sizeof out, "rid", "io", t);
    CHECK(n > 0 && strncmp(out, "ERR rid io 79:aaa", 17) == 0, out);
    CHECK_EQ_INT((int)strlen(out), 14 + 79);
    CHECK_EQ_INT(ar_err_line(out, 10, "rid", "io", "text"), -1);
}

static void line_verbs_and_rids(void) {
    char v[5], rid[AR_RID_MAX + 1];
    CHECK(ar_line_verb("VOL r1 9:Workbench 4:DH0: 1 2 3.4.5", v, rid) && !strcmp(v, "VOL") && !strcmp(rid, "r1"), "VOL");
    CHECK(ar_line_verb("ENT r1 f 1 0 1.0.0 1:a 0:", v, rid) && !strcmp(v, "ENT"), "ENT");
    CHECK(ar_line_verb("DONE r1 3 cut", v, rid) && !strcmp(v, "DONE"), "DONE");
    CHECK(ar_line_verb("ERR r1 off 3:off", v, rid) && !strcmp(v, "ERR"), "ERR");
    CHECK(ar_line_verb("GOT r1 7", v, rid) && !strcmp(v, "GOT") && !strcmp(rid, "r1"), "GOT");
    CHECK(ar_line_verb("ERR 11111111-2222-4333-8444-555555555555 write disk full", v, rid), "a download's ERR parses too");
    CHECK(!ar_line_verb("PONG", v, rid), "PONG");
    CHECK(!ar_line_verb("DONEX r1 1", v, rid), "DONEX");
    CHECK(!ar_line_verb("ERR  x", v, rid), "empty rid");
    CHECK(!ar_line_verb("GOT bad!rid 7", v, rid), "bad rid");
    CHECK(!ar_line_verb("PUT 1 5 1.2.3 0 1:a 0:", v, rid), "PUT");
}

static void got_table_ties_tag_and_rid(void) {
    ar_init(&R);
    ar_got_t *g = ar_got_add(&R, "g1", "7");
    CHECK(g && ar_got_by_tag(&R, "7") == g && ar_got_by_rid(&R, "g1") == g, "found both ways");
    CHECK(ar_got_by_tag(&R, "8") == NULL && ar_got_owed(&R) == NULL, "nothing else");
    ar_got_fail(g, "io", "Read error");
    ar_got_fail(g, "norx", "later");
    CHECK(g->err_owed && strcmp(g->err, "ERR g1 io 10:Read error") == 0, g->err);
    CHECK(ar_got_owed(&R) == g, "owed");
    int n = ar_late_body(&R, g);
    CHECK(strcmp(R.late, "{\"piece\":1,\"lines\":[\"ERR g1 io 10:Read error\"],\"last\":true}") == 0, R.late);
    CHECK_EQ_INT(n, (int)strlen(R.late));
    ar_got_remove(g);
    CHECK(ar_got_by_rid(&R, "g1") == NULL && ar_got_owed(&R) == NULL, "removed");
}

static void a_late_err_keeps_transfers_own_line(void) {
    ar_init(&R);
    ar_got_t *g = ar_got_add(&R, "g1", "7");
    ar_got_late(g, "ERR g1 toolarge 13:Too big: 5 MB");
    CHECK(g->err_owed && strcmp(g->err, "ERR g1 toolarge 13:Too big: 5 MB") == 0, g->err);
}

static void a_full_got_table_drops_the_oldest(void) {
    char rid[8], tag[4];
    ar_init(&R);
    for (int i = 0; i < AR_MAX; i++) { snprintf(rid, sizeof rid, "r%d", i); snprintf(tag, sizeof tag, "%d", i); ar_got_add(&R, rid, tag); }
    ar_got_add(&R, "new", "99");
    CHECK(ar_got_by_rid(&R, "r0") == NULL, "the oldest went");
    CHECK(ar_got_by_rid(&R, "r1") != NULL && ar_got_by_tag(&R, "99") != NULL, "the rest stay");
}

int main(void) {
    RUN(takes_vols_dir_and_get_in_order);
    RUN(malformed_lines_are_skipped_and_counted);
    RUN(a_last_line_without_newline_still_counts);
    RUN(a_piece_is_json_with_latin1_escaped);
    RUN(quotes_and_backslashes_are_escaped);
    RUN(full_leaves_room_for_any_line);
    RUN(a_piece_holds_at_most_400_lines);
    RUN(after_a_middle_piece_the_next_begins);
    RUN(end_err_while_a_piece_is_in_flight_goes_in_the_next);
    RUN(end_err_with_room_closes_at_once);
    RUN(end_err_on_a_discarded_answer_just_finishes);
    RUN(err_line_cuts_the_text_at_79);
    RUN(line_verbs_and_rids);
    RUN(got_table_ties_tag_and_rid);
    RUN(a_late_err_keeps_transfers_own_line);
    RUN(a_full_got_table_drops_the_oldest);
    return REPORT();
}
