#include "harness.h"
#include "../src/nfc_ui.h"

/*
 * The words the OLED shows for a tap (spec 2026-09-25 §4.4), which of them is
 * on the detail line at a given moment, and the board's own clock on a write
 * request. main.c only moves these values between cores; every decision about
 * them is here.
 */

static nfc_event_t ev_of(nfc_ev_kind_t k, const char *why) {
    nfc_event_t e;
    memset(&e, 0, sizeof e);
    e.kind = k;
    e.why = why;
    e.uid[0] = 0xde; e.uid[1] = 0xad; e.uid[2] = 0x0b; e.uid[3] = 0x01;
    e.uid_len = 4;
    return e;
}

// ---- the tap's verdict --------------------------------------------------------

static void tap_lines_are_the_spec_table(void) {
    char b[NFC_UI_LINE_BYTES];
    CHECK(strcmp(nfc_ui_tap_line(DC_TAP_MOUNTING, "Turrican", b, sizeof b), "Tag: Turrican") == 0,
          "a mount names the disk");
    CHECK(strcmp(nfc_ui_tap_line(DC_TAP_ALREADY, "Turrican", b, sizeof b), "Tag: already in drive") == 0,
          "the same disk again");
    CHECK(strcmp(nfc_ui_tap_line(DC_TAP_NOT_FOUND, "", b, sizeof b), "Tag: not in library") == 0,
          "not in this library");
    // The spec's words are 23 characters and the detail line holds 21
    // (DISP_DETAIL_MAX), so the glass shows them clipped. Pinned here so a
    // rewording is a deliberate change, not a surprise on the bench.
    CHECK(strcmp(nfc_ui_tap_line(DC_TAP_TOO_LONG, "X", b, sizeof b), "Tag: too long for boa") == 0,
          "tracks too long (clipped to the line)");
    CHECK(strcmp(nfc_ui_tap_line(DC_TAP_FAILED, "", b, sizeof b), "Tag: offline") == 0,
          "no usable answer reads as offline");
}

static void a_mount_without_a_title_still_says_something(void) {
    char b[NFC_UI_LINE_BYTES];
    CHECK(strcmp(nfc_ui_tap_line(DC_TAP_MOUNTING, "", b, sizeof b), "Tag: mounting") == 0,
          "never a bare 'Tag: '");
    CHECK(strcmp(nfc_ui_tap_line(DC_TAP_MOUNTING, NULL, b, sizeof b), "Tag: mounting") == 0,
          "NULL title too");
}

static void a_rate_limited_tap_changes_nothing(void) {
    char b[NFC_UI_LINE_BYTES];
    CHECK(nfc_ui_tap_line(DC_TAP_IGNORED, "Turrican", b, sizeof b) == NULL,
          "the server ignored it within its 1 s limit: the line stays as it was");
}

static void a_long_title_is_clipped_to_the_line(void) {
    char b[NFC_UI_LINE_BYTES];
    const char *s = nfc_ui_tap_line(DC_TAP_MOUNTING, "The Secret of Monkey Island", b, sizeof b);
    CHECK_EQ_INT((int)strlen(s), DISP_DETAIL_MAX);
    CHECK(strncmp(s, "Tag: The Secret of M", 20) == 0, "clipped, not wrapped");
}

// ---- local events -------------------------------------------------------------

static void local_event_lines(void) {
    nfc_event_t e = ev_of(NFC_EV_NOT_OURS, NULL);
    CHECK(strcmp(nfc_ui_event_line(&e), "Tag: not a disk tag") == 0, "no WFDK marker");
    e = ev_of(NFC_EV_UNREADABLE, "locked");
    CHECK(strcmp(nfc_ui_event_line(&e), "Tag: locked") == 0, "auth failed");
    e = ev_of(NFC_EV_UNREADABLE, "bad data");
    CHECK(strcmp(nfc_ui_event_line(&e), "Tag: unreadable") == 0, "CRC or shape");
    e = ev_of(NFC_EV_UNREADABLE, "moved");
    CHECK(strcmp(nfc_ui_event_line(&e), "Tag: unreadable") == 0, "pulled away mid-read");
    e = ev_of(NFC_EV_UNREADABLE, NULL);
    CHECK(strcmp(nfc_ui_event_line(&e), "Tag: unreadable") == 0, "no reason given");
    e = ev_of(NFC_EV_WRITE_DONE, NULL); e.ok = true;
    CHECK(strcmp(nfc_ui_event_line(&e), "Tag written") == 0, "read back OK");
    e = ev_of(NFC_EV_WRITE_DONE, "verify"); e.ok = false;
    CHECK(strcmp(nfc_ui_event_line(&e), "Write failed") == 0, "read back differed");
}

static void events_with_no_line_of_their_own(void) {
    nfc_event_t e = ev_of(NFC_EV_TAG_READ, NULL);
    CHECK(nfc_ui_event_line(&e) == NULL, "a read's line comes from the server's verdict");
    e = ev_of(NFC_EV_PRESENT, NULL);
    CHECK(nfc_ui_event_line(&e) == NULL, "presence is status, not a tap");
    e = ev_of(NFC_EV_ABSENT, NULL);
    CHECK(nfc_ui_event_line(&e) == NULL, "absence likewise");
}

static void the_armed_line(void) {
    char b[NFC_UI_LINE_BYTES];
    nfc_ui_armed_line("Turrican", b, sizeof b);
    CHECK(strncmp(b, "Tap tag to write: ", 18) == 0, "the spec's words, then the title");
    CHECK_EQ_INT((int)strlen(b), DISP_DETAIL_MAX);
    nfc_ui_armed_line("", b, sizeof b);
    CHECK(strcmp(b, "Tap tag to write") == 0, "no title: no dangling colon");
    nfc_ui_armed_line(NULL, b, sizeof b);
    CHECK(strcmp(b, "Tap tag to write") == 0, "NULL title too");
}

static void uid_as_hex(void) {
    char h[NFC_UI_UID_HEX_BYTES];
    nfc_event_t e = ev_of(NFC_EV_WRITE_DONE, NULL);
    nfc_ui_uid_hex(&e, h);
    CHECK(strcmp(h, "DEAD0B01") == 0, "four bytes, eight upper-case digits, zero-padded");
    e.uid_len = 0;
    nfc_ui_uid_hex(&e, h);
    CHECK(strcmp(h, "none") == 0, "no tag (a refused arm): never empty, the server needs 1+ chars");
}

// ---- which line is on the glass -------------------------------------------------

static void the_tag_line_holds_for_three_seconds(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    CHECK(strcmp(nfc_ui_detail("Disk 1/2", "Tag: offline", 1000, 1000, &a), "Tag: offline") == 0,
          "at once");
    CHECK(strcmp(nfc_ui_detail("Disk 1/2", "Tag: offline", 1000, 3999, &a), "Tag: offline") == 0,
          "still at 2.999 s");
    CHECK(strcmp(nfc_ui_detail("Disk 1/2", "Tag: offline", 1000, 4000, &a), "Disk 1/2") == 0,
          "the observer's line is back at 3 s");
}

static void no_tag_line_shows_the_base(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    CHECK(strcmp(nfc_ui_detail("192.168.1.9", "", 0, 10, &a), "192.168.1.9") == 0, "nothing tapped yet");
    CHECK(strcmp(nfc_ui_detail("192.168.1.9", NULL, 0, 10, &a), "192.168.1.9") == 0, "NULL tag");
    CHECK(strcmp(nfc_ui_detail("x", "Tag: offline", 0, 10, NULL), "Tag: offline") == 0,
          "NULL armed state is 'not armed'");
}

static void the_armed_line_holds_until_the_request_ends(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    nfc_armed_set(&a, 7, "Tap tag to write: X", 1000);
    CHECK(strcmp(nfc_ui_detail("base", "", 0, 50000, &a), "Tap tag to write: X") == 0,
          "persistent while armed, not a 3 s line");
    CHECK(strcmp(nfc_ui_detail("base", "Tag: not a disk tag", 50000, 51000, &a), "Tag: not a disk tag") == 0,
          "an event line shows over it...");
    CHECK(strcmp(nfc_ui_detail("base", "Tag: not a disk tag", 50000, 53000, &a), "Tap tag to write: X") == 0,
          "...and the armed line comes back after it, not the base");
    nfc_armed_clear(&a);
    CHECK(strcmp(nfc_ui_detail("base", "", 0, 60000, &a), "base") == 0, "disarmed: the normal line");
}

// ---- the write request's life on the board ----------------------------------------

static void a_write_expires_after_two_minutes(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    CHECK(!nfc_armed_expired(&a, 999999), "nothing armed never expires");
    nfc_armed_set(&a, 3, "l", 5000);
    CHECK(!nfc_armed_expired(&a, 5000 + NFC_WRITE_LIFETIME_MS - 1), "not a millisecond early");
    CHECK(nfc_armed_expired(&a, 5000 + NFC_WRITE_LIFETIME_MS), "at two minutes");
    CHECK_EQ_INT(NFC_WRITE_LIFETIME_MS, 120000);
}

static void re_arming_restarts_the_clock(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    nfc_armed_set(&a, 3, "l", 0);
    nfc_armed_set(&a, 4, "m", 100000);
    CHECK(!nfc_armed_expired(&a, 130000), "the newer request's two minutes");
    CHECK(nfc_armed_expired(&a, 220000), "and they end");
    CHECK_EQ_INT(a.seq, 4);
    CHECK(strcmp(a.line, "m") == 0, "the newer line");
}

static void expiry_survives_the_clock_wrapping(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    nfc_armed_set(&a, 1, "l", 0xFFFFF000u);
    CHECK(!nfc_armed_expired(&a, 0x00001000u), "8 s later, across the wrap");
    CHECK(nfc_armed_expired(&a, 0xFFFFF000u + NFC_WRITE_LIFETIME_MS), "two minutes, across the wrap");
}

// Task 9's ruling: a tag that is not ours, or unreadable, does not end a write
// request -- only its own WRITE_DONE does.
static void only_its_own_write_done_ends_a_request(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    nfc_armed_set(&a, 9, "l", 0);
    nfc_event_t e = ev_of(NFC_EV_NOT_OURS, NULL);
    nfc_armed_on_event(&a, &e);
    CHECK(a.armed, "not ours: still armed");
    e = ev_of(NFC_EV_UNREADABLE, "locked");
    nfc_armed_on_event(&a, &e);
    CHECK(a.armed, "locked: still armed");
    e = ev_of(NFC_EV_TAG_READ, NULL);
    nfc_armed_on_event(&a, &e);
    CHECK(a.armed, "a read: still armed");
    e = ev_of(NFC_EV_WRITE_DONE, NULL); e.seq = 8; e.ok = true;
    nfc_armed_on_event(&a, &e);
    CHECK(a.armed, "an older request's WRITE_DONE: still armed");
    e.seq = 9; e.ok = false; e.why = "verify";
    nfc_armed_on_event(&a, &e);
    CHECK(!a.armed, "its own WRITE_DONE ends it, failed or not");
}

int main(void) {
    RUN(tap_lines_are_the_spec_table);
    RUN(a_mount_without_a_title_still_says_something);
    RUN(a_rate_limited_tap_changes_nothing);
    RUN(a_long_title_is_clipped_to_the_line);
    RUN(local_event_lines);
    RUN(events_with_no_line_of_their_own);
    RUN(the_armed_line);
    RUN(uid_as_hex);
    RUN(the_tag_line_holds_for_three_seconds);
    RUN(no_tag_line_shows_the_base);
    RUN(the_armed_line_holds_until_the_request_ends);
    RUN(a_write_expires_after_two_minutes);
    RUN(re_arming_restarts_the_clock);
    RUN(expiry_survives_the_clock_wrapping);
    RUN(only_its_own_write_done_ends_a_request);
    return REPORT();
}
