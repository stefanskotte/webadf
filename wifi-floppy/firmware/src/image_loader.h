#ifndef IMAGE_LOADER_H
#define IMAGE_LOADER_H
// One bulk transfer per disk. The whole MFM image is streamed into PSRAM at
// mount; after that the emulator is network-independent and the floppy bus
// never waits on WiFi.
//
// This file is deliberately network-free: it used to also own image_load(),
// which called http_get_stream() (device-only, lwIP-backed) directly, so it
// could not be linked into the host test build at all -- and both recorded
// defects in the WFMF parser live here. image_load() and the http_fetch.h
// dependency were removed (see docs/superpowers/sdd/2026-08-30-device-
// firmware-protocol/task-3-report.md); the pure incremental parser below is
// what remains, and is host-testable.
//
// Task 10 gives core1 a real caller: device_client.c's dc_fetch_image feeds
// this parser directly from dc_exchange's read-chunk sink
// (image_parse_begin/feed/end below), rather than buffering a whole image
// (up to ~2 MB, see psram_image.h) in SRAM first -- the RP2350 does not have
// 2 MB of SRAM to spare for that. image_parse_buffer() is a thin
// whole-buffer wrapper around the same three calls, kept for the host tests
// (test_image_loader.c) that already build a complete image in memory.
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// Blob served by the webservice at GET /image/<id>:
//   u32 magic 'WFMF' (0x464D4657 LE)
//   u32 version (1)
//   u32 track_count
//   u32 reserved
//   per track, in order:  u32 bit_count, then ceil(bits/8) bytes,
//                         padded up to a 4-byte boundary
#define IMAGE_MAGIC   0x464D4657u
#define IMAGE_VERSION 1u

// Starts a new parse into PSRAM slot `slot` (task 8) -- normally the one
// psram_inactive_slot() names, so a fetch never touches whatever the
// active slot is currently streaming. Resets `slot` up front so stale data
// from an earlier aborted parse can never be mistaken for this one.
void image_parse_begin(int slot);

// Feeds the next chunk of body bytes (in the order they arrived) into the
// parse started by image_parse_begin(). Safe to call with any chunk size,
// including one byte at a time -- the parser is fully resumable at any
// byte boundary (mirrors http_resp_feed's contract). Payload bytes are
// written straight into the PSRAM slot as they arrive; nothing here
// buffers a whole track, let alone a whole image.
void image_parse_feed(const uint8_t *data, int len);

// Ends the parse: true only if every byte fed since image_parse_begin()
// forms a complete, well-formed WFMF container with every track present.
// False on any failure (truncated, malformed, or an out-of-range track
// count/bit count) -- in which case the slot is reset back to empty and
// must not be published (psram_publish_slot) as the active one.
bool image_parse_end(void);

// Synchronous whole-buffer convenience wrapper: image_parse_begin(slot),
// image_parse_feed(data, len), image_parse_end(), in one call. Used by the
// host tests, which already hold a complete image in memory; device_client.c
// uses the three calls above directly so it never needs the whole image
// buffered at once.
bool image_parse_buffer(int slot, const uint8_t *data, size_t len);

int  image_load_percent(void);      // progress, for logging / an LED
#endif
