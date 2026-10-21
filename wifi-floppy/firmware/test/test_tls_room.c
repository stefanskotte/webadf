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

int main(void) {
    RUN(needed_counts_record_segments_and_reserve);
    RUN(the_bench_case_waits_then_goes);
    RUN(boundary_and_odd_stats);
    return REPORT();
}
