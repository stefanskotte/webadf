#ifndef NFC_UI_H
#define NFC_UI_H
// What tap-to-mount shows, and for how long (spec 2026-09-25 §4.4, §6).
//
// main.c moves these values between the cores; every decision about them is
// here, where a host test can judge it:
//   * the detail line for a tap's server verdict, and for a local event;
//   * which line is on the glass at a moment: a tag line for NFC_UI_LINE_MS,
//     else "Tap tag to write: ..." while a write is armed, else the line the
//     state observer last set;
//   * the board's own two-minute clock on an armed write, and what ends one.
//
// WHY the 3 s revert is decided at render time on core0, not by a timer on
// core1: core1 spends up to 25 s inside a held poll, so a revert it scheduled
// would land up to 25 s late. core0 composes the panel every 1 ms anyway, so
// it overlays the tag line on the observer's detail and simply stops once
// the line is 3 s old; the observer's own line is never overwritten, so
// there is nothing to "restore". The write request's expiry runs on core0
// for the same reason: it owns the reader, and it is never blocked.
//
// RULE: pure C -- C standard headers and the project's pure headers only.
#include <stdint.h>
#include <stdbool.h>
#include "nfc_reader.h"
#include "device_client.h"
#include "display.h"

#define NFC_UI_LINE_MS         3000u
#define NFC_WRITE_LIFETIME_MS  120000u
#define NFC_UI_LINE_BYTES      (DISP_DETAIL_MAX + 1)
#define NFC_UI_UID_HEX_BYTES   9

// The detail line for dc_tap's verdict, written into `buf` (clipped to fit).
// NULL = show nothing new (DC_TAP_IGNORED: the server's 1 s rate limit).
const char *nfc_ui_tap_line(dc_tap_outcome_t o, const char *title, char *buf, int cap);

// The line for an event core1 shows without asking the server: NOT_OURS,
// UNREADABLE (by its `why`) and WRITE_DONE. NULL for the rest.
const char *nfc_ui_event_line(const nfc_event_t *ev);

// "Tap tag to write: <title>", or "Tap tag to write" with no title.
void nfc_ui_armed_line(const char *title, char *buf, int cap);

// The tag's UID as upper-case hex for POST /tap-write, or "none" when the
// event has no tag (the server's `uid` must be at least one character).
void nfc_ui_uid_hex(const nfc_event_t *ev, char out[NFC_UI_UID_HEX_BYTES]);

// core0's view of the armed write request.
typedef struct {
    bool     armed;
    uint32_t seq;
    uint32_t since;
    char     line[NFC_UI_LINE_BYTES];
} nfc_armed_t;

void nfc_armed_init(nfc_armed_t *a);
void nfc_armed_set(nfc_armed_t *a, uint32_t seq, const char *line, uint32_t now);
void nfc_armed_clear(nfc_armed_t *a);
// Armed for NFC_WRITE_LIFETIME_MS or more: the caller disarms the reader.
bool nfc_armed_expired(const nfc_armed_t *a, uint32_t now);
// Only the request's OWN WRITE_DONE ends it. A tag that is not ours, or is
// unreadable, leaves it armed (Task 9's ruling): the operator is still
// holding the right tag somewhere.
void nfc_armed_on_event(nfc_armed_t *a, const nfc_event_t *ev);

// Which detail line is on the glass: `tag` while it is under NFC_UI_LINE_MS
// old (published at `tag_at`), else the armed line, else `base`. `tag` may be
// NULL or "", `armed` may be NULL.
const char *nfc_ui_detail(const char *base, const char *tag, uint32_t tag_at, uint32_t now,
                          const nfc_armed_t *armed);

#endif
