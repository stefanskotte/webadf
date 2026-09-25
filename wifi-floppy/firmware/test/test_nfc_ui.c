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
    // Reworded to fit the 21-character detail line whole (controller ruling
    // after the whole-branch review): the spec's "too long for board" was
    // 23 and showed clipped.
    CHECK(strcmp(nfc_ui_tap_line(DC_TAP_TOO_LONG, "X", b, sizeof b), "Tag: tracks too long") == 0,
          "tracks too long");
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

static void a_rate_limited_tap_says_so(void) {
    char b[NFC_UI_LINE_BYTES];
    const char *s = nfc_ui_tap_line(DC_TAP_IGNORED, "Turrican", b, sizeof b);
    CHECK(s != NULL && strcmp(s, "Tag: too fast") == 0,
          "the server ignored it within its 1 s limit -- and the glass says why");
}

// Every FIXED line must fit the 21-character detail line whole. Rendered into
// a buffer far wider than the line, so a string that only fits because
// snprintf clipped it still fails here.
static void every_fixed_line_fits_the_detail_line(void) {
    char b[64];
    const dc_tap_outcome_t fixed[] = { DC_TAP_ALREADY, DC_TAP_NOT_FOUND, DC_TAP_TOO_LONG,
                                       DC_TAP_IGNORED, DC_TAP_FAILED };
    for (unsigned k = 0; k < sizeof fixed / sizeof fixed[0]; k++) {
        const char *s = nfc_ui_tap_line(fixed[k], "", b, sizeof b);
        CHECK(s != NULL, "every verdict has words");
        if (s) {
            if ((int)strlen(s) > DISP_DETAIL_MAX) printf("  too long: \"%s\"\n", s);
            CHECK((int)strlen(s) <= DISP_DETAIL_MAX, "tap line fits 21");
        }
    }
    CHECK((int)strlen(nfc_ui_tap_line(DC_TAP_MOUNTING, "", b, sizeof b)) <= DISP_DETAIL_MAX,
          "the untitled mount line fits");
    const char *whys[] = { NULL, "locked", "bad data", "moved", "verify" };
    const nfc_ev_kind_t kinds[] = { NFC_EV_NOT_OURS, NFC_EV_UNREADABLE, NFC_EV_WRITE_DONE };
    for (unsigned k = 0; k < sizeof kinds / sizeof kinds[0]; k++)
        for (unsigned w = 0; w < sizeof whys / sizeof whys[0]; w++)
            for (int ok = 0; ok < 2; ok++) {
                nfc_event_t e = ev_of(kinds[k], whys[w]); e.ok = ok;
                const char *s = nfc_ui_event_line(&e);
                CHECK(s != NULL && (int)strlen(s) <= DISP_DETAIL_MAX, "event line fits 21");
            }
    CHECK((int)strlen(NFC_UI_ARMED_DETAIL) <= DISP_DETAIL_MAX, "the armed line fits 21");
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

static void the_armed_line_is_fixed_words(void) {
    CHECK(strcmp(NFC_UI_ARMED_DETAIL, "Tap tag to write") == 0,
          "the detail line while armed; the disk's title goes on the title line");
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
    nfc_tag_clock_t c; nfc_tag_clock_init(&c);
    CHECK(nfc_tag_clock_live(&c, 1, 1000, 1000), "at once");
    CHECK(nfc_tag_clock_live(&c, 1, 1000, 3999), "still at 2.999 s");
    CHECK(!nfc_tag_clock_live(&c, 1, 1000, 4000), "gone at 3 s");
    CHECK(nfc_tag_clock_live(&c, 2, 9000, 9001), "a NEW line is live again");
    nfc_armed_t a; nfc_armed_init(&a);
    CHECK(strcmp(nfc_ui_detail("Disk 1/2", "Tag: offline", true, &a), "Tag: offline") == 0,
          "a live tag line shows");
    CHECK(strcmp(nfc_ui_detail("Disk 1/2", "Tag: offline", false, &a), "Disk 1/2") == 0,
          "an expired one does not");
}

static void nothing_published_is_never_live(void) {
    nfc_tag_clock_t c; nfc_tag_clock_init(&c);
    CHECK(!nfc_tag_clock_live(&c, 0, 0, 10), "boot: no line has been published");
}

// The ms clock wraps every 49.7 days. A line three seconds old must not come
// back for three seconds when `now - at` wraps round to small again.
static void an_old_tag_line_stays_gone_across_the_wrap(void) {
    nfc_tag_clock_t c; nfc_tag_clock_init(&c);
    CHECK(nfc_tag_clock_live(&c, 1, 1000, 1000), "live when published");
    CHECK(!nfc_tag_clock_live(&c, 1, 1000, 5000), "gone after 3 s");
    CHECK(!nfc_tag_clock_live(&c, 1, 1000, 1000u + 0x80000000u), "gone 24 days later");
    CHECK(!nfc_tag_clock_live(&c, 1, 1000, 999u), "gone at 2^32 - 1 ms elapsed, just before the wrap");
    CHECK(!nfc_tag_clock_live(&c, 1, 1000, 1500), "and gone once the clock has wrapped past it");
}

static void a_line_published_just_before_the_wrap_lasts_three_seconds(void) {
    nfc_tag_clock_t c; nfc_tag_clock_init(&c);
    CHECK(nfc_tag_clock_live(&c, 1, 0xFFFFFF00u, 0xFFFFFF00u), "published");
    CHECK(nfc_tag_clock_live(&c, 1, 0xFFFFFF00u, 0x00000100u), "0.5 s later, across the wrap");
    CHECK(!nfc_tag_clock_live(&c, 1, 0xFFFFFF00u, 0xFFFFFF00u + NFC_UI_LINE_MS), "3 s, across the wrap");
}

static void no_tag_line_shows_the_base(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    CHECK(strcmp(nfc_ui_detail("192.168.1.9", "", true, &a), "192.168.1.9") == 0, "empty tag");
    CHECK(strcmp(nfc_ui_detail("192.168.1.9", NULL, true, &a), "192.168.1.9") == 0, "NULL tag");
    CHECK(strcmp(nfc_ui_detail("x", "Tag: offline", true, NULL), "Tag: offline") == 0,
          "NULL armed state is 'not armed'");
    CHECK(strcmp(nfc_ui_title("Turrican II", NULL), "Turrican II") == 0, "NULL armed: the base title");
}

// While armed: the disk to be written on the TITLE line, "Tap tag to write"
// on the detail line. Both go back to what they were (they are overlays, the
// published lines underneath are never touched) when the request ends.
static void armed_shows_the_title_and_the_instruction(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    nfc_armed_set(&a, 7, "Turrican II", 1000);
    CHECK(strcmp(nfc_ui_title("Lemmings", &a), "Turrican II") == 0, "the disk to write, on the title line");
    CHECK(strcmp(nfc_ui_detail("base", "", false, &a), "Tap tag to write") == 0,
          "persistent while armed, not a 3 s line");
    CHECK(strcmp(nfc_ui_detail("base", "Tag: not a disk tag", true, &a), "Tag: not a disk tag") == 0,
          "an event line shows over it...");
    CHECK(strcmp(nfc_ui_detail("base", "Tag: not a disk tag", false, &a), "Tap tag to write") == 0,
          "...and the armed line comes back after it, not the base");
    nfc_armed_clear(&a);
    CHECK(strcmp(nfc_ui_detail("base", "", false, &a), "base") == 0, "disarmed: the normal detail");
    CHECK(strcmp(nfc_ui_title("Lemmings", &a), "Lemmings") == 0, "disarmed: the normal title");
}

static void armed_without_a_title_keeps_the_title_line(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    nfc_armed_set(&a, 7, "", 0);
    CHECK(strcmp(nfc_ui_title("Lemmings", &a), "Lemmings") == 0, "no title to show: leave it");
    CHECK(strcmp(nfc_ui_detail("base", "", false, &a), "Tap tag to write") == 0, "still the instruction");
    nfc_armed_set(&a, 8, NULL, 0);
    CHECK(strcmp(nfc_ui_title("Lemmings", &a), "Lemmings") == 0, "NULL title too");
}

static void write_done_and_expiry_restore_the_lines(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    nfc_armed_set(&a, 9, "Turrican II", 0);
    nfc_event_t e = ev_of(NFC_EV_WRITE_DONE, NULL); e.seq = 9; e.ok = true;
    nfc_armed_on_event(&a, &e);
    CHECK(strcmp(nfc_ui_title("Lemmings", &a), "Lemmings") == 0, "WRITE_DONE: title back");
    CHECK(strcmp(nfc_ui_detail("base", "", false, &a), "base") == 0, "WRITE_DONE: detail back");
    nfc_armed_set(&a, 10, "Turrican II", 0);
    CHECK(nfc_armed_expired(&a, NFC_WRITE_LIFETIME_MS), "expired");
    CHECK(strcmp(nfc_ui_title("Lemmings", &a), "Lemmings") == 0, "expiry: title back");
    CHECK(strcmp(nfc_ui_detail("base", "", false, &a), "base") == 0, "expiry: detail back");
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
    CHECK_EQ_INT(a.seq, 4);
    CHECK(strcmp(a.title, "m") == 0, "the newer title");
    CHECK(nfc_armed_expired(&a, 220000), "and they end");
}

// An expired arm ends ONCE: it is cleared by the check that finds it
// expired, so when `now - since` wraps round to small 49.7 days later it
// cannot read as armed (or unexpired) again, even if the caller never
// cleared it.
static void an_expired_arm_stays_ended_across_the_wrap(void) {
    nfc_armed_t a; nfc_armed_init(&a);
    nfc_armed_set(&a, 5, "Turrican II", 5000);
    CHECK(nfc_armed_expired(&a, 5000 + NFC_WRITE_LIFETIME_MS), "expired at two minutes");
    CHECK(!a.armed, "and ended by that check");
    CHECK(!nfc_armed_expired(&a, 5000 + NFC_WRITE_LIFETIME_MS + 1), "reported once");
    CHECK(strcmp(nfc_ui_detail("base", "", false, &a), "base") == 0, "not armed after the wrap");
    CHECK(strcmp(nfc_ui_title("Lemmings", &a), "Lemmings") == 0, "title not back after the wrap");
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
    RUN(a_rate_limited_tap_says_so);
    RUN(every_fixed_line_fits_the_detail_line);
    RUN(a_long_title_is_clipped_to_the_line);
    RUN(local_event_lines);
    RUN(events_with_no_line_of_their_own);
    RUN(the_armed_line_is_fixed_words);
    RUN(uid_as_hex);
    RUN(the_tag_line_holds_for_three_seconds);
    RUN(nothing_published_is_never_live);
    RUN(an_old_tag_line_stays_gone_across_the_wrap);
    RUN(a_line_published_just_before_the_wrap_lasts_three_seconds);
    RUN(no_tag_line_shows_the_base);
    RUN(armed_shows_the_title_and_the_instruction);
    RUN(armed_without_a_title_keeps_the_title_line);
    RUN(write_done_and_expiry_restore_the_lines);
    RUN(a_write_expires_after_two_minutes);
    RUN(re_arming_restarts_the_clock);
    RUN(an_expired_arm_stays_ended_across_the_wrap);
    RUN(expiry_survives_the_clock_wrapping);
    RUN(only_its_own_write_done_ends_a_request);
    return REPORT();
}
