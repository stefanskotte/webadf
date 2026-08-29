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

// image_loader.c rejects anything longer: TRACK_SLOT_BYTES (13312) * 8.
export const FIRMWARE_MAX_TRACK_BITS = 106496;
