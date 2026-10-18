/* PaulaNET LZ4, board -> Amiga (pnet_pack.h). Ours. The track's layout is pnet_frame.h's; this builder writes what
 * pnet_build_to_amiga writes, with an LZ4 frame's block in place of its MFM bytes. */
#include "pnet_pack.h"
#include "pnet_mfm.h"
#include <string.h>

#ifndef PNET_TX_LEAD_BYTES
#define PNET_TX_LEAD_BYTES PNET_LEAD_BYTES     /* as pnet_frame.c: CMake sets the board's */
#endif

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }

static size_t wire_of(const pnet_out_t *f) { return 2u * (size_t)(f->lz4_len ? f->lz4_len : f->len); }

size_t pnet_out_payload_bytes(const pnet_out_t *f, unsigned n) {
    if (n == 0) return 0;
    size_t b = 4;
    for (unsigned i = 0; i < n; i++) b += 8u + wire_of(&f[i]);
    return b;
}

unsigned pnet_pack(pnet_pack_t *pk, const pnet_pack_mem_t *m, bool lz4, const pnet_frame_ref_t *in, unsigned avail,
                   size_t cap) {
    memset(pk, 0, sizeof *pk);
    /* Bench fix (seq 100, controller's ruling): the table is never cleared here. Its 8 KB PSRAM clear took 584 us on the
     * board -- the whole budget, before the first encode. The encoder never trusts an entry (pnet_lz4.c: one at or past
     * the position is ignored, any other is byte-verified), so an entry left by an earlier batch costs compression at
     * most, never correctness; main.c zeroes the table once at boot. The price: a re-pack of the same frames need not
     * be byte-identical -- main.c re-packs only when the LZ4 setting changes, and then the frames, not the bytes, are
     * what must hold (pnet_pack.h). */
    const uint32_t t0 = lz4 && avail && m->now_us ? m->now_us() : 0u;   /* review I1: the budget's start */
    if (avail > PNET_MAX_FRAMES) avail = PNET_MAX_FRAMES;
    size_t dec = 0, blk = 0, payload = 4;
    for (unsigned i = 0; i < avail; i++) {
        const uint16_t len = in[i].len;
        if (len == 0 || len > PNET_ETH_MTU || PNET_LZ4_WIN_BYTES(len) > PNET_LZ4_WINDOW - dec) break;   /* pad counted */
        const uint8_t *data = in[i].data;
        size_t z = 0;
        if (lz4) {
            memcpy(m->win + dec, data, len);
            data = m->win + dec;
            if (!pk->budget && m->now_us && (uint32_t)(m->now_us() - t0) >= PNET_PACK_LZ4_BUDGET_US)
                pk->budget = true;                       /* spent: the rest of the batch goes MFM, unencoded */
            if (!pk->budget) {
                pk->encodes++;
                z = pnet_lz4_encode_linked(data, len, m->blk + blk, (size_t)len - 1u, m->table, m->entries, m->win);
            }
        }
        const size_t wire = 2u * (z ? z : len);
        if (payload + 8u + wire > PNET_TO_AMIGA_MAX_PAYLOAD ||
            PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + payload + 8u + wire + PNET_TRAIL_BYTES + 3u > cap) break;
        pk->f[i].data = data;
        pk->f[i].len = len;
        pk->f[i].lz4 = z ? m->blk + blk : NULL;
        pk->f[i].lz4_len = (uint16_t)z;
        if (z) { pk->lz4++; pk->saved += 2u * (uint32_t)(len - z); }
        if (lz4 && pk->budget) pk->unencoded++;
        /* The next frame at an even window offset (pnet_lz4.h): the pad is written as 0 with LZ4, the decoder's twin;
         * without LZ4 m->win is not touched and the count only (the MFM payload limit binds first anyway). */
        if (lz4) dec = pnet_lz4_win_advance(m->win, dec, len);
        else dec += PNET_LZ4_WIN_BYTES(len);
        blk += z;
        payload += 8u + wire;
        pk->n++;
    }
    pk->wire = pk->n ? (uint32_t)payload : 0u;
    return pk->n;
}

size_t pnet_build_to_amiga_out(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr, uint8_t flags,
                               const pnet_out_t *f, unsigned n) {
    if (n > PNET_MAX_FRAMES) return 0;
    for (unsigned i = 0; i < n; i++)
        if (f[i].len == 0 || f[i].len > PNET_ETH_MTU || f[i].lz4_len > 0x3FFFu || (f[i].lz4_len && !f[i].lz4))
            return 0;
    const size_t pb = pnet_out_payload_bytes(f, n);
    if (PNET_TX_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + pb + PNET_TRAIL_BYTES + 3u > cap) return 0;
    memset(out, 0xAA, PNET_TX_LEAD_BYTES);
    uint8_t *s = out + PNET_TX_LEAD_BYTES;
    uint8_t *pay = s + 4 + PNET_HDR_MFM_BYTES;
    size_t plen = 0;
    if (n) {
        const uint8_t ph[2] = { (uint8_t)n, flags };
        uint16_t last = 0;
        plen = pnet_mfm_encode(ph, 2, pay, &last);
        for (unsigned i = 0; i < n; i++) {
            const bool z = f[i].lz4_len != 0;
            uint8_t ch[4];
            put16(ch, (uint16_t)(z ? (0x8000u | PNET_SIZE_LZ4 | f[i].lz4_len) : (0x8000u | 2u * f[i].len)));
            put16(ch + 2, f[i].len);
            last = 0;                                   /* each header from a clean start */
            pnet_mfm_encode(ch, 4, pay + plen, &last);
            pnet_mfm_encode(z ? f[i].lz4 : f[i].data, z ? f[i].lz4_len : f[i].len, pay + plen + 8, &last);
            plen += 8u + wire_of(&f[i]);
        }
    }
    const pnet_hdr_t h = {
        .checksum = pnet_checksum(pay, plen), .data_size = (uint16_t)plen,
        .compressed_size = (uint16_t)plen, .mode = PNET_MODE_ETHERNET, .compressed = 0,
        .amiga_ctr = amiga_ctr, .pico_ctr = pico_ctr,
    };
    pnet_put_hdr_to_amiga(s, &h);
    const size_t pos = (size_t)(pay - out) + plen;
    const size_t end = (pos + PNET_TRAIL_BYTES + 3u) & ~(size_t)3u;
    memset(out + pos, 0xAA, end - pos);
    return end;
}
