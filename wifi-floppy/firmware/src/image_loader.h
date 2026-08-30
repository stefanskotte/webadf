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
// firmware-protocol/task-3-report.md); the pure incremental parser and
// image_parse_buffer() below are what remain, and are host-testable. Task 10
// deletes http_fetch.c and gives core1 a real caller for image_parse_buffer().
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

// Synchronous whole-buffer entry point around the same incremental parser
// image_load() used to drive from the network one chunk at a time. `slot` is
// unused today (there is only ever one active PSRAM image); it is there so a
// future multi-image cache doesn't need a signature change. False on any
// failure, in which case the image is left incomplete and no disk should be
// presented.
bool image_parse_buffer(int slot, const uint8_t *data, size_t len);

int  image_load_percent(void);      // progress, for logging / an LED
#endif
