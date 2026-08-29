#ifndef IMAGE_LOADER_H
#define IMAGE_LOADER_H
// One bulk transfer per disk. The whole MFM image is streamed into PSRAM at
// mount; after that the emulator is network-independent and the floppy bus
// never waits on WiFi.
#include <stdint.h>
#include <stdbool.h>

// Blob served by the webservice at GET /image/<id>:
//   u32 magic 'WFMF' (0x464D4657 LE)
//   u32 version (1)
//   u32 track_count
//   u32 reserved
//   per track, in order:  u32 bit_count, then ceil(bits/8) bytes,
//                         padded up to a 4-byte boundary
#define IMAGE_MAGIC   0x464D4657u
#define IMAGE_VERSION 1u

// Blocking. Streams the image into PSRAM. False on any failure, in which
// case the image is left incomplete and no disk should be presented.
bool image_load(int image_id);

int  image_load_percent(void);      // progress, for logging / an LED
#endif
