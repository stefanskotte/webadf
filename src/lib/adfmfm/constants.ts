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
// container outright: TRACK_SLOT_BYTES (13312) * 8.
export const FIRMWARE_ACCEPT_TRACK_BITS = 106496;

// The real safe ceiling: TRACK_MFM_MAX (13000, floppy_io.h:29) * 8. Tighter
// than FIRMWARE_ACCEPT_TRACK_BITS because image_loader.c (image_loader.c:52)
// accepts more than the buffers it writes into can actually hold —
// track_cache.c:14's `uint8_t data[TRACK_MFM_MAX]` and main.c:28's
// `track_words[(TRACK_MFM_MAX + 3) / 4]`. That gap between what the loader
// accepts and what the cache can hold is a live firmware defect, recorded in
// the spec's §7. TRACK_BITS must stay at or under this value, not under
// FIRMWARE_ACCEPT_TRACK_BITS, or the device overflows SRAM per track.
export const FIRMWARE_SAFE_TRACK_BITS = 104000;

// Bump whenever a change alters encoder OUTPUT (e.g. GAP_LEAD_BYTES,
// TRACK_BITS, or anything else that changes the bytes encodeDisk produces).
// WFMF_VERSION is the container format version and does not change for this;
// any cache keyed on an ADF's SHA-256 alone must also key on ENCODER_VERSION,
// or a stale cached blob will be served forever after such a change.
export const ENCODER_VERSION = 1;
