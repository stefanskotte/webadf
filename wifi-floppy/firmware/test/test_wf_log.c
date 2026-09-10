#include "harness.h"
#include "../src/wf_log.h"
#include <string.h>
#include <stdlib.h>

// The properties worth pinning are the ones that decide whether the log can
// be trusted during bring-up: that it is FIFO, that it survives wraparound,
// and above all that a full ring is reported rather than silently swallowed.
// A logger that quietly loses the three records either side of a fault is
// worse than no logger, because it invites a wrong conclusion.

#define MAX_LINES 512
static char captured[MAX_LINES][160];
static int  n_captured;

static void sink(const char *line) {
    if (n_captured < MAX_LINES) {
        snprintf(captured[n_captured], sizeof captured[0], "%s", line);
    }
    n_captured++;
}

static void begin(void) {
    wf_log_test_reset();
    wf_log_test_set_sink(sink);
    n_captured = 0;
}

static int captured_contains(const char *needle) {
    for (int i = 0; i < n_captured && i < MAX_LINES; i++) {
        if (strstr(captured[i], needle)) return 1;
    }
    return 0;
}

// ---------------------------------------------------------------------
static void test_fifo_order(void) {
    begin();
    for (int i = 0; i < 5; i++) wf_logf(WF_INFO, "line %d", i);
    int n = wf_log_drain(100);
    CHECK_EQ_INT(n, 5);
    CHECK_EQ_INT(n_captured, 5);
    for (int i = 0; i < 5; i++) {
        char want[32];
        snprintf(want, sizeof want, "line %d", i);
        CHECK(strstr(captured[i], want) != NULL, "records must come out in order");
    }
}

static void test_drain_is_bounded(void) {
    begin();
    for (int i = 0; i < 10; i++) wf_logf(WF_INFO, "x%d", i);
    CHECK_EQ_INT(wf_log_drain(4), 4);
    CHECK_EQ_INT(n_captured, 4);
    CHECK_EQ_INT(wf_log_drain(4), 4);
    CHECK_EQ_INT(wf_log_drain(100), 2);
    CHECK_EQ_INT(wf_log_drain(100), 0);   // nothing left, and no drop line
}

static void test_wraparound(void) {
    begin();
    const int cap = wf_log_test_capacity();
    // Fill, drain, fill again: the second pass crosses the end of the array.
    for (int i = 0; i < cap; i++) wf_logf(WF_INFO, "a%d", i);
    CHECK_EQ_INT(wf_log_drain(1000), cap);
    n_captured = 0;
    for (int i = 0; i < cap; i++) wf_logf(WF_INFO, "b%d", i);
    CHECK_EQ_INT(wf_log_drain(1000), cap);
    CHECK_EQ_INT(n_captured, cap);
    CHECK(strstr(captured[0], "b0") != NULL, "wrapped ring must still be FIFO");
    CHECK(captured_contains("b1") && captured_contains("b2"),
          "no record may be lost across the wrap");
}

// The one that matters most.
static void test_overflow_is_counted_not_swallowed(void) {
    begin();
    const int cap = wf_log_test_capacity();
    for (int i = 0; i < cap + 7; i++) wf_logf(WF_INFO, "f%d", i);
    CHECK_EQ_INT((int)wf_log_dropped(), 7);

    int n = wf_log_drain(1000);
    // cap records, plus one line accounting for the 7 that were lost
    CHECK_EQ_INT(n, cap + 1);
    CHECK(captured_contains("7 record(s) dropped"),
          "an overflow must be reported, never silently swallowed");
    CHECK_EQ_INT((int)wf_log_dropped(), 0);   // reported once, then cleared

    // Oldest are kept, newest are the ones dropped.
    CHECK(captured_contains("f0"), "oldest record must survive an overflow");
    CHECK(!captured_contains("f70"), "newest records are the ones dropped");
}

static void test_drop_line_waits_for_the_backlog(void) {
    begin();
    const int cap = wf_log_test_capacity();
    for (int i = 0; i < cap + 3; i++) wf_logf(WF_INFO, "g%d", i);
    // A partial drain must NOT announce the drops yet: the count is only
    // final once the ring is empty.
    wf_log_drain(2);
    CHECK(!captured_contains("dropped"),
          "drops are reported after the backlog clears, not during it");
    wf_log_drain(1000);
    CHECK(captured_contains("3 record(s) dropped"), "and then they are reported");
}

static void test_trace_renders_without_a_format_string(void) {
    begin();
    wf_log_test_set_now(12345678);          // 12.345 s
    wf_trace(WF_EV_STEP, 40, 1);
    wf_trace(WF_EV_INDEX, 0, 0);
    wf_log_drain(100);
    CHECK_EQ_INT(n_captured, 2);
    CHECK(strstr(captured[0], "STEP") != NULL, "event code must render as a name");
    CHECK(strstr(captured[0], "a=40") != NULL, "and carry its operands");
    CHECK(strstr(captured[0], "b=1") != NULL, "both of them");
    CHECK(strstr(captured[0], "[   12.345]") != NULL, "timestamp is s.ms since boot");
    CHECK(strstr(captured[1], "INDEX") != NULL, "second event renders too");
}

static void test_every_event_code_has_a_name(void) {
    begin();
    for (int ev = 0; ev < WF_EV__COUNT; ev++) wf_trace((wf_ev_t)ev, 0, 0);
    wf_log_drain(1000);
    CHECK_EQ_INT(n_captured, WF_EV__COUNT);
    for (int i = 0; i < n_captured; i++) {
        // A missing name would leave the column blank or print garbage.
        CHECK(strstr(captured[i], "a=0 b=0") != NULL, "record is well formed");
        CHECK(strlen(captured[i]) > 20, "event name column is not empty");
        CHECK(strstr(captured[i], "(null)") == NULL, "no missing name");
    }
}

static void test_levels_are_tagged(void) {
    begin();
    wf_logf(WF_INFO, "quiet");
    wf_logf(WF_WARN, "careful");
    wf_logf(WF_ERR,  "broken");
    wf_log_drain(100);
    CHECK(strstr(captured[0], "WARN") == NULL, "info carries no tag");
    CHECK(strstr(captured[1], "WARN careful") != NULL, "warn is tagged");
    CHECK(strstr(captured[2], "ERROR broken") != NULL, "error is tagged");
}

static void test_long_message_is_truncated_not_overrun(void) {
    begin();
    char big[400];
    memset(big, 'z', sizeof big - 1);
    big[sizeof big - 1] = '\0';
    wf_logf(WF_INFO, "%s", big);
    wf_log_drain(100);
    CHECK_EQ_INT(n_captured, 1);
    CHECK(strlen(captured[0]) < 160, "an oversized message must be truncated");
    CHECK(strstr(captured[0], "zzzz") != NULL, "and still show what it can");
}

// ---------------------------------------------------------------------
// The hold. These exist because the sink above ALWAYS accepts, and the real
// one does not: a detached USB CDC port discards silently. Every test before
// this point would pass just as happily against a logger whose every record
// went nowhere, which is what shipped and what a board measured on
// 2026-09-10 actually did with its boot banner.
static void test_nothing_is_drained_while_detached(void) {
    begin();
    wf_log_test_set_ready(0);
    wf_logf(WF_INFO, "boot");
    wf_trace(WF_EV_STEP, 3, 0);
    CHECK_EQ_INT(wf_log_drain(100), 0);
    CHECK_EQ_INT(n_captured, 0);
    CHECK_EQ_INT((int)wf_log_dropped(), 0);   // held, not dropped
}

static void test_held_records_survive_until_a_terminal_attaches(void) {
    begin();
    wf_log_test_set_ready(0);
    wf_logf(WF_INFO, "wifi-floppy boot");
    wf_logf(WF_INFO, "radio up");
    wf_log_drain(100);                        // the drain that used to destroy them
    CHECK_EQ_INT(n_captured, 0);

    wf_log_test_set_ready(1);
    CHECK_EQ_INT(wf_log_drain(100), 2);
    CHECK(strstr(captured[0], "wifi-floppy boot") != NULL,
          "the boot banner must still be there when someone finally attaches");
    CHECK(strstr(captured[1], "radio up") != NULL, "and in order");
}

static void test_a_long_detachment_keeps_the_boot_history_and_reports_the_loss(void) {
    begin();
    const int cap = wf_log_test_capacity();
    wf_log_test_set_ready(0);
    wf_logf(WF_INFO, "boot marker");
    for (int i = 0; i < cap + 4; i++) {       // overrun it while nobody listens
        wf_logf(WF_INFO, "later%d", i);
        wf_log_drain(4);                      // the service loop, still calling
    }
    wf_log_test_set_ready(1);
    wf_log_drain(1000);
    CHECK(captured_contains("boot marker"),
          "a long detachment must cost the NEWEST records, not the boot history");
    CHECK(captured_contains("record(s) dropped"),
          "and the loss must be reported rather than silent");
}

static void test_detaching_again_stops_the_drain(void) {
    begin();
    wf_logf(WF_INFO, "seen");
    CHECK_EQ_INT(wf_log_drain(100), 1);
    wf_log_test_set_ready(0);
    wf_logf(WF_INFO, "unseen");
    CHECK_EQ_INT(wf_log_drain(100), 0);
    CHECK(!captured_contains("unseen"), "a terminal that goes away stops the drain");
    wf_log_test_set_ready(1);
    wf_log_drain(100);
    CHECK(captured_contains("unseen"), "and the record was waiting for it");
}

int main(void) {
    RUN(test_fifo_order);
    RUN(test_drain_is_bounded);
    RUN(test_wraparound);
    RUN(test_overflow_is_counted_not_swallowed);
    RUN(test_drop_line_waits_for_the_backlog);
    RUN(test_trace_renders_without_a_format_string);
    RUN(test_every_event_code_has_a_name);
    RUN(test_levels_are_tagged);
    RUN(test_long_message_is_truncated_not_overrun);
    RUN(test_nothing_is_drained_while_detached);
    RUN(test_held_records_survive_until_a_terminal_attaches);
    RUN(test_a_long_detachment_keeps_the_boot_history_and_reports_the_loss);
    RUN(test_detaching_again_stops_the_drain);
    return REPORT();
}
