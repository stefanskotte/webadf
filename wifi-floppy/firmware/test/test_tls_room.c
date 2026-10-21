#include "harness.h"
#include "../src/tls_room.h"

// tls_room.h decides when a TLS write may go (bench 2026-10-21: ERR_MEM about
// every 30 s during uploads from the Amiga). What it must get right: a whole
// record's segments plus the Amiga's reserve, never a wrap on odd stats.

static void needed_counts_record_segments_and_reserve(void) {
    // 4096 payload + 29 = 4125 on the wire = 3 segments of 1460.
    CHECK_EQ_INT(tls_room_needed(4096, 1460), 4125 + 3 * TLS_ROOM_SEG_OVERHEAD + TLS_ROOM_RESERVE);
    // 1 byte: one segment.
    CHECK_EQ_INT(tls_room_needed(1, 1460), 30 + TLS_ROOM_SEG_OVERHEAD + TLS_ROOM_RESERVE);
    // exactly one MSS on the wire: still one segment.
    CHECK_EQ_INT(tls_room_needed(1460 - 29, 1460), 1460 + TLS_ROOM_SEG_OVERHEAD + TLS_ROOM_RESERVE);
}

static void the_bench_case_waits_then_goes(void) {
    // 24 KB heap; a full TLS send queue (8 segments) plus the Amiga's out-of-order queue and a frame.
    const uint32_t heap = 24576, sndq = 8 * (1460 + TLS_ROOM_SEG_OVERHEAD), amiga = 2920 + 1514 + 200;
    CHECK(!tls_room_ok(heap, sndq + amiga, 4096, 1460), "full send queue and a busy Amiga: wait");
    CHECK(tls_room_ok(heap, 4 * (1460 + TLS_ROOM_SEG_OVERHEAD) + amiga, 4096, 1460), "half acknowledged: go");
    CHECK(tls_room_ok(heap, 0, 4096, 1460), "an empty heap always has room for one record");
}

static void boundary_and_odd_stats(void) {
    const uint32_t need = tls_room_needed(4096, 1460);
    CHECK(tls_room_ok(need, 0, 4096, 1460), "exactly enough");
    CHECK(!tls_room_ok(need - 1, 0, 4096, 1460), "one byte short");
    CHECK(!tls_room_ok(100, 200, 1, 1460), "used > avail reads as no room, not a wrap");
}

// Bench 2026-10-21 (fw 1.20.1's log): `write 1 parked: out_left=37 sndbuf=1`. The TLS layer's send space is TCP's
// minus mbedTLS's own expansion estimate, which is short of what a record really adds, so a write sized to it
// overflows TCP and is parked; the next write fails and the connection goes. tls_write_len sizes a write from
// TCP's free space with a full margin, and waits (0) rather than dribble out tiny records.
static void a_write_leaves_room_for_the_record_overhead(void) {
    CHECK_EQ_INT(tls_write_len(16384, 4096, 11680), 4096);                        // room for a whole record
    CHECK_EQ_INT(tls_write_len(16384, 4096, 2000), 2000 - TLS_ROOM_RECORD_MARGIN);  // a smaller record that fits
    CHECK_EQ_INT(tls_write_len(100, 4096, 100 + TLS_ROOM_RECORD_MARGIN), 100);      // a short request, exactly
}
static void a_nearly_full_send_buffer_waits(void) {
    CHECK_EQ_INT(tls_write_len(16384, 4096, 38), 0);    // the bench case: never a 1-byte record
    CHECK_EQ_INT(tls_write_len(16384, 4096, 0), 0);
    CHECK_EQ_INT(tls_write_len(16384, 4096, TLS_ROOM_RECORD_MARGIN + TLS_ROOM_MIN_RECORD - 1), 0);
    CHECK_EQ_INT(tls_write_len(16384, 4096, TLS_ROOM_RECORD_MARGIN + TLS_ROOM_MIN_RECORD), TLS_ROOM_MIN_RECORD);
    CHECK_EQ_INT(tls_write_len(10, 4096, TLS_ROOM_RECORD_MARGIN + 10), 10);       // a short write is not held back
    CHECK_EQ_INT(tls_write_len(10, 4096, TLS_ROOM_RECORD_MARGIN + 9), 0);
}

int main(void) {
    RUN(needed_counts_record_segments_and_reserve);
    RUN(the_bench_case_waits_then_goes);
    RUN(boundary_and_odd_stats);
    RUN(a_write_leaves_room_for_the_record_overhead);
    RUN(a_nearly_full_send_buffer_waits);
    return REPORT();
}
