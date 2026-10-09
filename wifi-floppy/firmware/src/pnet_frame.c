/* PaulaNET protocol (C) 2026 RobSmithDev, used with permission -- see pnet_frame.h. */
#include "pnet_frame.h"
#include "pnet_mfm.h"
#include <string.h>

const char *pnet_err_text(pnet_err_t e) {
    static const char *const t[] = {
        "ok", "short", "magic", "mode", "size", "checksum",
        "frames", "frame size", "rle", "full", "no sync", "out of range",
    };
    _Static_assert(sizeof t / sizeof t[0] == PNET_E_COUNT, "one text per pnet_err_t");
    return (unsigned)e < PNET_E_COUNT ? t[e] : "?";
}

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static uint16_t get16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }

static void hdr_pack(const pnet_hdr_t *h, uint8_t *b) {
    put16(b, PNET_MAGIC);
    put16(b + 2, h->checksum);
    put16(b + 4, h->data_size);
    put16(b + 6, h->compressed_size);
    b[8] = h->mode; b[9] = h->compressed; b[10] = h->amiga_ctr; b[11] = h->pico_ctr;
}

/* False if the magic is wrong; the fields are filled either way. */
static bool hdr_unpack(const uint8_t *b, pnet_hdr_t *h) {
    h->checksum = get16(b + 2);
    h->data_size = get16(b + 4);
    h->compressed_size = get16(b + 6);
    h->mode = b[8]; h->compressed = b[9]; h->amiga_ctr = b[10]; h->pico_ctr = b[11];
    return get16(b) == PNET_MAGIC;
}

size_t pnet_payload_bound(const uint16_t *lens, unsigned n) {
    if (n == 0) return 0;
    size_t b = 4;
    for (unsigned i = 0; i < n; i++) b += 8u + pnet_rle_bound(lens[i]);
    return b;
}

size_t pnet_to_amiga_bound(const uint16_t *lens, unsigned n) {
    return PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + pnet_payload_bound(lens, n)
         + PNET_TRAIL_BYTES + 3u;
}

/* The payload bound for frame refs; SIZE_MAX if any is unsendable. */
static size_t refs_bound(const pnet_frame_ref_t *f, unsigned n) {
    if (n > PNET_MAX_FRAMES) return SIZE_MAX;
    if (n == 0) return 0;
    size_t b = 4;
    for (unsigned i = 0; i < n; i++) {
        if (f[i].len == 0 || f[i].len > PNET_ETH_MTU) return SIZE_MAX;
        b += 8u + pnet_rle_bound(f[i].len);
    }
    return b;
}

static size_t put_payload(uint8_t *p, pnet_dir_t dir, uint8_t flags,
                          const pnet_frame_ref_t *f, unsigned n) {
    const uint8_t ph[2] = { (uint8_t)n, flags };
    uint16_t last = 0;
    size_t pos = pnet_mfm_encode(ph, 2, p, &last);
    for (unsigned i = 0; i < n; i++) {
        const size_t r = pnet_rle_encode(f[i].data, f[i].len, p + pos + 8);   // even: padded
        uint16_t size = (uint16_t)r;
        if (dir == PNET_TO_BOARD) size |= 0x8000u;    // toward the board, bit 15 means RLE
        uint8_t ch[4];
        put16(ch, size);
        put16(ch + 2, f[i].len);
        last = 0;                                     // each header from a clean start
        pnet_mfm_encode(ch, 4, p + pos, &last);
        pos += 8u + r;
    }
    return pos;
}

size_t pnet_build_to_board(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                           const pnet_frame_ref_t *f, unsigned n) {
    const size_t pb = refs_bound(f, n);
    if (pb == SIZE_MAX || 4u + PNET_HDR_BYTES + pb + 2u > cap) return 0;
    out[0] = 0x00; out[1] = 0x01; out[2] = 0x00; out[3] = 0x01;
    uint8_t *pay = out + 4 + PNET_HDR_BYTES;
    const size_t plen = n ? put_payload(pay, PNET_TO_BOARD, 0, f, n) : 0;
    const pnet_hdr_t h = {
        .checksum = pnet_checksum(pay, plen), .data_size = (uint16_t)plen,
        .compressed_size = (uint16_t)plen, .mode = PNET_MODE_ETHERNET,
        .compressed = PNET_COMPRESSED_MFM | PNET_FROM_DRIVER,
        .amiga_ctr = amiga_ctr, .pico_ctr = pico_ctr,
    };
    hdr_pack(&h, out + 4);                            // RAW in this direction
    size_t pos = 4u + PNET_HDR_BYTES + plen;
    out[pos++] = 0xAA;
    out[pos++] = 0xAA;
    return pos;
}

size_t pnet_build_to_amiga(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                           uint8_t flags, const pnet_frame_ref_t *f, unsigned n) {
    const size_t pb = refs_bound(f, n);
    if (pb == SIZE_MAX ||
        PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + pb + PNET_TRAIL_BYTES + 3u > cap) return 0;
    memset(out, 0xAA, PNET_LEAD_BYTES);
    uint8_t *s = out + PNET_LEAD_BYTES;
    s[0] = 0x44; s[1] = 0x89; s[2] = 0x44; s[3] = 0x89;
    uint8_t *pay = s + 4 + PNET_HDR_MFM_BYTES;
    const size_t plen = n ? put_payload(pay, PNET_TO_AMIGA, flags, f, n) : 0;
    const pnet_hdr_t h = {
        .checksum = pnet_checksum(pay, plen), .data_size = (uint16_t)plen,
        .compressed_size = (uint16_t)plen, .mode = PNET_MODE_ETHERNET, .compressed = 0,
        .amiga_ctr = amiga_ctr, .pico_ctr = pico_ctr,
    };
    uint8_t raw[PNET_HDR_BYTES];
    hdr_pack(&h, raw);
    uint16_t last = 0;
    pnet_mfm_encode(raw, PNET_HDR_BYTES, s + 4, &last);   // MFM in this direction
    const size_t pos = (size_t)(pay - out) + plen;
    const size_t end = (pos + PNET_TRAIL_BYTES + 3u) & ~(size_t)3u;
    memset(out + pos, 0xAA, end - pos);
    return end;
}

pnet_err_t pnet_parse_hdr_from_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h) {
    if (len < PNET_HDR_BYTES) return PNET_E_SHORT;
    if (!hdr_unpack(b, h)) return PNET_E_MAGIC;
    if (h->mode != PNET_MODE_ETHERNET) return PNET_E_MODE;
    if ((h->compressed_size & 1u) || PNET_HDR_BYTES + (size_t)h->compressed_size >= len)
        return PNET_E_SIZE;
    if (pnet_checksum(b + PNET_HDR_BYTES, h->compressed_size) != h->checksum)
        return PNET_E_CHECKSUM;
    return PNET_OK;
}

pnet_err_t pnet_parse_hdr_to_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload) {
    if (len < PNET_HDR_MFM_BYTES) return PNET_E_SHORT;
    uint8_t raw[PNET_HDR_BYTES];
    pnet_mfm_decode(b, PNET_HDR_BYTES, raw);
    if (!hdr_unpack(raw, h)) return PNET_E_MAGIC;
    if (h->mode != PNET_MODE_ETHERNET) return PNET_E_MODE;
    if (!with_payload) return PNET_OK;
    if (h->data_size & 1u) return PNET_E_SIZE;
    if (PNET_HDR_MFM_BYTES + (size_t)h->data_size > len) return PNET_E_SHORT;
    if (pnet_checksum(b + PNET_HDR_MFM_BYTES, h->data_size) != h->checksum) return PNET_E_CHECKSUM;
    return PNET_OK;
}

pnet_err_t pnet_parse_frames(const uint8_t *p, size_t len, pnet_dir_t dir, uint8_t *out,
                             size_t cap, uint16_t *lens, unsigned max, unsigned *n) {
    *n = 0;
    if (len == 0) return PNET_OK;
    if (len < 4) return PNET_E_FRAMES;
    uint8_t ph[2];
    pnet_mfm_decode(p, 2, ph);
    const unsigned count = ph[0];
    if (count > max) return PNET_E_FRAMES;
    size_t pos = 4, used = 0;
    for (unsigned i = 0; i < count; i++) {
        if (8u > len - pos) return PNET_E_FRAMES;
        uint8_t ch[4];
        pnet_mfm_decode(p + pos, 4, ch);
        pos += 8u;
        const uint16_t field = get16(ch), os = get16(ch + 2);
        const size_t size = field & 0x7FFFu;
        const bool rle = dir == PNET_TO_BOARD ? (field & 0x8000u) != 0 : (field & 0x8000u) == 0;
        if (size > len - pos) return PNET_E_FRAMES;
        if (os == 0 || os > PNET_ETH_MTU) return PNET_E_FRAME_SIZE;
        if (os > cap - used) return PNET_E_FULL;
        if (rle) {
            if (pnet_rle_decode(p + pos, size, out + used, os) != (long)os) return PNET_E_RLE;
        } else {
            if (size != 2u * os) return PNET_E_FRAME_SIZE;
            pnet_mfm_decode(p + pos, os, out + used);
        }
        lens[i] = os;
        used += os;
        pos += size + (size & 1u);
        if (pos > len) pos = len;
    }
    *n = count;
    return PNET_OK;
}

long pnet_find_sync(const uint8_t *b, size_t len, size_t scan) {
    uint32_t reg = 0;
    const size_t limit = scan + 4u < len ? scan + 4u : len;
    for (size_t i = 0; i < limit; i++) {
        for (unsigned k = 0; k < 8u; k++) {
            reg = (reg << 1) | ((b[i] >> (7u - k)) & 1u);
            const size_t bits = i * 8u + k + 1u;
            if (bits >= 32u && reg == PNET_SYNC_WORDS) return (long)bits;
        }
    }
    return -1;
}

size_t pnet_shift_left(uint8_t *b, size_t len, size_t bits) {
    const size_t q = bits >> 3;
    const unsigned r = (unsigned)(bits & 7u);
    if (q >= len) return 0;
    const size_t valid = len - q - (r ? 1u : 0u);
    for (size_t i = 0; i < valid; i++)
        b[i] = r ? (uint8_t)((b[i + q] << r) | (b[i + q + 1] >> (8u - r))) : b[i + q];
    return valid;
}
