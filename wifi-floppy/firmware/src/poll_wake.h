#ifndef POLL_WAKE_H
#define POLL_WAKE_H
// When a long poll that core1 is waiting in should give core1 back
// (HANDOFF 3av): a tap is waiting, or a write has landed since the poll
// began. Only a tap used to, so a save made during a held poll waited for
// the poll to return -- 20 s on the bench, 2026-10-04.
//
// `write_ms` is core0's g_write_last_ms (stamped when a write is applied);
// `mark` is its value taken just before this poll started. A cursor, not a
// flag: retaken before every poll, a write that was already seen (and
// uploaded) can never cut the NEXT poll short, so a parked uploader cannot
// turn this into polls as fast as the server answers. Inequality, not
// ordering, so the 49-day wrap needs no special case. Pure: host-tested.
#include <stdbool.h>
#include <stdint.h>

static inline bool poll_should_yield(bool tap_waiting, uint32_t write_ms, uint32_t mark) {
    return tap_waiting || write_ms != mark;
}

#endif
