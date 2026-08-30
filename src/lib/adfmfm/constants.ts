// Every value here is derived in docs/superpowers/specs/2026-08-29-adfmfm-encoder-design.md §1
// and was measured against Greaseweazle's amiga.amigados codec. Do not "tidy" any of them.

export const SECTORS = 11;
export const TRACKS = 160;
export const SECTOR_DATA_BYTES = 512;
export const TRACK_DATA_BYTES = SECTORS * SECTOR_DATA_BYTES; // 5632
export const ADF_BYTES = TRACKS * TRACK_DATA_BYTES;          // 901120

// 14 PAL colour clocks per bitcell (7,093,790 Hz) gives 101,339.86 bitcells in
// a 200 ms revolution; rounded UP to a multiple of 32 because main.c's DMA
// re-triggers on a word count and a partial final word would emit
// uninitialised SRAM as flux.
export const TRACK_BITS = 101344;
export const TRACK_BYTES = TRACK_BITS / 8;                   // 12668

export const SECTOR_MFM_BYTES = 1088;
export const GAP_LEAD_BYTES = 256;
export const GAP_TRAIL_BYTES = 444;

export const WFMF_MAGIC = 0x464d4657; // 'WFMF' little-endian
export const WFMF_VERSION = 1;
export const WFMF_HEADER_BYTES = 16;
export const WFMF_BYTES = WFMF_HEADER_BYTES + TRACKS * (4 + TRACK_BYTES); // 2027536

// The largest bit_count image_loader.c will accept before rejecting the
// container outright: TRACK_MAX_BYTES (psram_image.h) * 8.
export const FIRMWARE_ACCEPT_TRACK_BITS = 106496;

// Historically this repo's task-3 spec (§7) recorded a *second*, tighter
// ceiling here: TRACK_MFM_MAX (13000, floppy_io.h) * 8 = 104000. That was a
// live firmware defect, not a design choice -- image_loader.c's PSRAM-slot
// guard accepted up to TRACK_SLOT_BYTES=13312 while track_cache.c's SRAM
// staging buffer, sized TRACK_MFM_MAX=13000, could not hold that much, so a
// track between the two overflowed the buffer on every read. The firmware
// fix reconciled both C constants into a single TRACK_MAX_BYTES=13312, so
// there is no longer a second, tighter number to mirror here: this constant
// is now simply an alias for FIRMWARE_ACCEPT_TRACK_BITS, kept under its own
// name so callers that named the ceiling by its old "safe" role don't need
// to change, but it can never silently diverge from the accept ceiling
// again -- there is only one C constant behind both of these now.
export const FIRMWARE_SAFE_TRACK_BITS = FIRMWARE_ACCEPT_TRACK_BITS;

// Bump whenever a change alters encoder OUTPUT (e.g. GAP_LEAD_BYTES,
// TRACK_BITS, or anything else that changes the bytes encodeDisk produces).
// WFMF_VERSION is the container format version and does not change for this;
// any cache keyed on an ADF's SHA-256 alone must also key on ENCODER_VERSION,
// or a stale cached blob will be served forever after such a change.
export const ENCODER_VERSION = 1;
