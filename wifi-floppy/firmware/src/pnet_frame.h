#ifndef PNET_FRAME_H
#define PNET_FRAME_H
/*
 * PaulaNET's wire format on cylinder 77, both directions.
 *
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09; THIRD-PARTY-NOTICES.md). Implemented from the
 * protocol's description; none of his code is in this file.
 *
 * Amiga -> board (side 0, ETD_RAWWRITE; pnet_build_to_board):
 *   00 01 00 01      two pulses 16 cells apart: the board times the cell from them
 *   DataHeader       12 bytes RAW, big-endian (this direction does not MFM-encode it)
 *   payload          compressed_size bytes
 *   AA AA            trailer
 * Board -> Amiga (side 1, ETD_RAWREAD + IOTDF_INDEXSYNC; pnet_build_to_amiga):
 *   120 x AA         lead-in for Paula's data separator
 *   44 89 44 89      sync, found by the Amiga in software at any bit offset
 *   DataHeader       12 bytes, MFM-encoded (24 bytes)
 *   payload          data_size bytes
 *   >= 120 x AA      trailer, to a whole number of 32-bit words (the board's DMA unit)
 * DataHeader, big-endian: magic 0x5450, checksum (XOR of the payload's big-endian words),
 *   data_size, compressed_size, mode (3 = Ethernet), compressed (0x42 from the Amiga's driver:
 *   2 "MFM" | 0x40 "from driver"; 0 from the board), amiga counter, pico counter.
 * Payload (empty when there are no frames): PacketsHeader {count, flags}, MFM (4 bytes); then per
 *   frame a CompressionHeader {size, original size}, MFM (8 bytes, each chunk encoded from a
 *   clean start), then `size` bytes of RLE (or of MFM), padded to even. Bit 15 of `size` means
 *   RLE toward the board, but MFM toward the Amiga -- the two directions disagree, so the
 *   direction is a parameter (pnet_dir_t), never a guess.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define PNET_CYL             77
#define PNET_TRACK_IN        (PNET_CYL * 2)       /* 154: side 0, the Amiga writes */
#define PNET_TRACK_OUT       (PNET_CYL * 2 + 1)   /* 155: side 1, the Amiga reads */
#define PNET_MAGIC           0x5450u
#define PNET_MODE_ETHERNET   3u
#define PNET_FROM_DRIVER     0x40u
#define PNET_COMPRESSED_MFM  2u
#define PNET_HDR_BYTES       12u
#define PNET_HDR_MFM_BYTES   24u
#define PNET_LEAD_BYTES      120u
#define PNET_TRAIL_BYTES     120u
#define PNET_SYNC_WORDS      0x44894489u
#define PNET_ETH_MTU         1518u
#define PNET_MAX_FRAMES      20u

typedef enum { PNET_TO_BOARD, PNET_TO_AMIGA } pnet_dir_t;

typedef enum {
    PNET_OK = 0, PNET_E_SHORT, PNET_E_MAGIC, PNET_E_MODE, PNET_E_SIZE, PNET_E_CHECKSUM,
    PNET_E_FRAMES, PNET_E_FRAME_SIZE, PNET_E_RLE, PNET_E_FULL, PNET_E_NOSYNC,
    PNET_E_RANGE,      /* board: the capture holds a gap over PNET_RX_MAX_CELLS (clamped cells) */
    PNET_E_COUNT
} pnet_err_t;
const char *pnet_err_text(pnet_err_t e);

typedef struct {
    uint16_t checksum, data_size, compressed_size;
    uint8_t  mode, compressed, amiga_ctr, pico_ctr;
} pnet_hdr_t;

typedef struct { const uint8_t *data; uint16_t len; } pnet_frame_ref_t;

/* Worst-case payload bytes for frames of these lengths (0 for none). */
size_t pnet_payload_bound(const uint16_t *lens, unsigned n);
/* Worst-case length of a whole board -> Amiga track for these frames. */
size_t pnet_to_amiga_bound(const uint16_t *lens, unsigned n);

/* Both builders return the bytes written, or 0 when `cap` might not hold the result, when n is
 * over PNET_MAX_FRAMES, or a frame is empty or over PNET_ETH_MTU. Frames go out RLE. */
size_t pnet_build_to_board(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                           const pnet_frame_ref_t *f, unsigned n);
size_t pnet_build_to_amiga(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                           uint8_t flags, const pnet_frame_ref_t *f, unsigned n);

/* Board side: `b` is the capture from the first bit after the 00 01 00 01 sync. Checks magic,
 * mode, size (12 + compressed_size must be LESS than len, as PaulaNET's receiver requires) and
 * checksum. The payload is then at b + PNET_HDR_BYTES, h->compressed_size bytes. */
pnet_err_t pnet_parse_hdr_from_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h);

/* Amiga side: `b` is aligned at the first bit after the 44 89 44 89 sync. With with_payload,
 * also checks that data_size payload bytes follow the 24 header bytes and their checksum. */
pnet_err_t pnet_parse_hdr_to_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload);

/* Decodes a payload's frames, back to back, into out[0..cap). lens[i] is frame i's length; *n
 * the count. PNET_E_FULL when they would not fit `cap`. */
pnet_err_t pnet_parse_frames(const uint8_t *p, size_t len, pnet_dir_t dir, uint8_t *out,
                             size_t cap, uint16_t *lens, unsigned max, unsigned *n);

/* The bit offset just past 44 89 44 89, when the sync STARTS within b[0..scan); -1 if absent. */
long pnet_find_sync(const uint8_t *b, size_t len, size_t scan);

/* Shifts b left by `bits` in place: b[i] takes the 8 bits from bit offset bits + 8i. Returns
 * how many leading bytes are whole afterwards. */
size_t pnet_shift_left(uint8_t *b, size_t len, size_t bits);
#endif
