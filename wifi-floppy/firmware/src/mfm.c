#include "mfm.h"
#include <string.h>

/*
 * A flux interval, in ns, to the number of MFM bitcells it spans.
 *
 * Amiga DD uses a 2 us bitcell and MFM guarantees one transition every 2, 3 or
 * 4 cells -- so the only intervals a healthy stream produces are 4, 6 and 8 us.
 *
 * THE THRESHOLDS MUST SIT BETWEEN THOSE VALUES, not at them. The version this
 * replaces used 3000 and 5000 while its own comments said "~4us -> 10", which
 * meant a textbook-perfect 4 us gap was classified as a 3-cell gap: the code
 * and the comment beside it disagreed, and the code was wrong. It had never
 * run -- mfm_decode_track was a stub returning -1 -- so nothing caught it.
 *
 *   < 5000  a 4 us gap (2 cells), tolerant to +25% / -25%
 *   < 7000  a 6 us gap (3 cells)
 *   else    an 8 us gap (4 cells)
 *
 * Midpoints give every bucket a full 1 us of margin either side, which is far
 * more than the few percent a drive's speed actually varies by.
 */
int mfm_interval_to_bits(uint32_t ns) {
    if (ns < 5000) return 2;        //  ~4us  -> 10
    if (ns < 7000) return 3;        //  ~6us  -> 100
    return 4;                       //  ~8us  -> 1000
}

uint32_t mfm_checksum(const uint8_t *src, size_t len) {
    uint32_t c = 0;
    for (size_t i = 0; i + 3 < len; i += 4) {
        c ^= ((uint32_t)src[i] << 24) | ((uint32_t)src[i + 1] << 16)
           | ((uint32_t)src[i + 2] << 8) | (uint32_t)src[i + 3];
    }
    return (c ^ (c >> 1)) & 0x55555555u;
}

void mfm_join_odd_even(const uint8_t *src, size_t n, uint8_t *dst) {
    for (size_t i = 0; i < n; i++) {
        dst[i] = (uint8_t)(((src[i] << 1) & 0xaa) | (src[n + i] & 0x55));
    }
}

static uint32_t be32(const uint8_t *b) {
    return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16)
         | ((uint32_t)b[2] << 8)  | (uint32_t)b[3];
}

/* `n` bytes of `m`, starting `bit` bits in, into `dst`. */
static void realign(const uint8_t *m, size_t bit, uint8_t *dst, size_t n) {
    if ((bit & 7u) == 0) { memcpy(dst, m + (bit >> 3), n); return; }
    const size_t byte = bit >> 3;
    const unsigned sh = (unsigned)(bit & 7u);
    for (size_t i = 0; i < n; i++) {
        dst[i] = (uint8_t)((m[byte + i] << sh) | (m[byte + i + 1] >> (8u - sh)));
    }
}

// The sector after its sync, realigned to a byte boundary: header, label,
// both checksums and data, 1,080 bytes. NOT MFM_SECTOR_MFM_BYTES - 4: that
// counts the next sector's 4-byte preamble too, and demanding it dropped the
// last sector of every real write, whose capture ends just past its data
// (2026-09-15).
#define SEC_BODY_BYTES (MFM_SECTOR_MFM_BYTES - 8)

void mfm_decode_track_r(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                        mfm_decode_result_t *out, uint8_t *scratch) {
    memset(out, 0, sizeof *out);
    out->track_no_consistent = true;
    bool have_track_no = false;

    // Review (final), Critical C1: EVERY large working buffer lives in the
    // caller's scratch (mfm.h, MFM_DECODE_SCRATCH_BYTES), none in static
    // storage. This decoder now runs on both cores at once -- core0 decoding
    // the Amiga's captured writes, core1's uploader decoding PSRAM tracks to
    // upload and hash -- and a shared static `sec` let one core's realign()
    // splice its sector body into the other's mid-decode: a real sector
    // with a valid checksum, on the wrong track. Nor on the stack: core1's
    // stack is 2 KB (device_client.c's STACK note), so its caller keeps its
    // scratch static instead -- its own, never core0's.
    uint8_t *sec  = scratch;
    uint8_t *data = scratch + SEC_BODY_BYTES;
    // The small per-candidate fields stay on the stack: 48 bytes, private to
    // this call by construction.
    uint8_t header[4], label[16], hdrsum_raw[4], datsum_raw[4];
    uint8_t header_and_label[20];
    const size_t body_bits = (size_t)SEC_BODY_BYTES * 8u;

    // The sync is searched for at EVERY BIT, not every byte. A write capture
    // starts at whatever edge came first after WGATE, so the Amiga's bit grid
    // lands at any of eight offsets -- and one interval bucketed wrongly in a
    // gap shifts everything after it. Each sector carries its own sync, so each
    // is realigned from its own. The byte-only search this replaces decoded
    // 10 of 11 sectors or none at all from the first real writes (2026-09-15).
    const size_t total_bits = len * 8u;
    uint32_t sr = 0;
    for (size_t b = 0; b < total_bits; b++) {
        sr = (sr << 1) | ((mfm[b >> 3] >> (7u - (b & 7u))) & 1u);
        // 0x4489 twice. The sync word cannot occur in encoded data: it
        // deliberately breaks the MFM clock rule, which is the whole reason
        // Paula can lock onto it.
        if (b < 31u || sr != 0x44894489u) continue;
        const size_t body = b + 1u;
        // Every bit of the body must be in the capture. When the body starts
        // off a byte boundary, realign() reads the byte holding its last bits,
        // which this same condition guarantees exists.
        if (body + body_bits > total_bits) break;
        realign(mfm, body, sec, SEC_BODY_BYTES);

        size_t at = 0;
        mfm_join_odd_even(sec + at, 4,   header);      at += 8;
        mfm_join_odd_even(sec + at, 16,  label);       at += 32;
        mfm_join_odd_even(sec + at, 4,   hdrsum_raw);  at += 8;
        mfm_join_odd_even(sec + at, 4,   datsum_raw);  at += 8;
        mfm_join_odd_even(sec + at, MFM_SECTOR_DATA_BYTES, data);

        memcpy(header_and_label, header, 4);
        memcpy(header_and_label + 4, label, 16);

        bool ok = mfm_checksum(header_and_label, 20) == be32(hdrsum_raw)
               && mfm_checksum(data, MFM_SECTOR_DATA_BYTES) == be32(datsum_raw);

        uint8_t sector_id = header[2];
        if (!ok || sector_id >= MFM_SECTORS) {
            // Advance by ONE BIT, not by a sector: a false sync inside data
            // would otherwise skip 1088 bytes and step over the real sector
            // that follows it. Only a sector that verifies earns the long stride.
            out->bad_checksums++;
            continue;
        }

        // The track number every sector header carries. A write that landed
        // on the wrong cylinder produces a perfectly valid track whose id is
        // not the one the head is on -- the one corruption a checksum cannot
        // see, because every sector of it is internally consistent.
        if (!have_track_no) {
            out->track_no = header[1]; have_track_no = true;
            out->first_sync_bit = (uint32_t)(body - 32u);
            out->first_id = sector_id;
        } else if (header[1] != out->track_no) { out->track_no_consistent = false; }
        out->last_id = sector_id;
        out->last_end_bit = (uint32_t)(body + body_bits);

        // First good copy wins. A capture over more than one revolution sees
        // each sector twice; both copies are the same bytes, and taking the
        // first keeps this independent of where the capture happened to
        // start.
        if (!(out->found & (1u << sector_id))) {
            out->found |= (uint16_t)(1u << sector_id);
            memcpy(adf_out + (size_t)sector_id * MFM_SECTOR_DATA_BYTES,
                   data, MFM_SECTOR_DATA_BYTES);
        }
        b = body + body_bits - 1u;
        sr = 0;
    }
}

// core0's decoder: the capture decode and the verify re-decode, both on
// core0's service loop, one at a time -- never core1, which calls
// mfm_decode_track_r with scratch of its own (uploader.c). This static is
// core0's alone for exactly that reason; see mfm.h.
void mfm_decode_track(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                      mfm_decode_result_t *out) {
    static uint8_t core0_scratch[MFM_DECODE_SCRATCH_BYTES];
    mfm_decode_track_r(mfm, len, adf_out, out, core0_scratch);
}

/* ---- the read direction's encoder, ported from src/lib/adfmfm ---------- */

void mfm_split_odd_even(const uint8_t *src, size_t n, uint8_t *dst) {
    for (size_t i = 0; i < n; i++) {
        dst[i]     = (uint8_t)((src[i] >> 1) & 0x55);
        dst[n + i] = (uint8_t)(src[i] & 0x55);
    }
}

/* A clock bit goes wherever neither neighbouring data bit is set. The 16-bit
 * window carries the rule across byte boundaries; the 0x4489 sync needs no
 * special case (see fillClockBits in mfm.ts for why). */
void mfm_fill_clock_bits(uint8_t *track, size_t len) {
    uint32_t y = 0;
    for (size_t i = 0; i < len; i++) {
        const uint32_t x = track[i];
        y = ((y << 8) | x) & 0xffffu;
        if ((x & 0xaau) == 0) y |= ~((y >> 1) | (y << 1)) & 0xaaaau;
        y &= 0xffu;
        track[i] = (uint8_t)y;
    }
}

static void put_be32(uint8_t *b, uint32_t v) {
    b[0] = (uint8_t)(v >> 24); b[1] = (uint8_t)(v >> 16);
    b[2] = (uint8_t)(v >> 8);  b[3] = (uint8_t)v;
}

uint32_t mfm_encode_track(const uint8_t *data, uint8_t track_no, uint8_t *out) {
    static const uint8_t label[16];            /* all zero, as encodeTrack writes */
    memset(out, 0, MFM_TRACK_BYTES);           /* the gaps are zeros before clocking */
    for (unsigned n = 0; n < MFM_SECTORS; n++) {
        const uint8_t *sd = data + (size_t)n * MFM_SECTOR_DATA_BYTES;
        /* Header: format 0xff, track, sector, sectors left to the gap. The
         * checksum covers header AND label, raw, before the split. */
        uint8_t hl[20] = { 0xff, track_no, (uint8_t)n, (uint8_t)(MFM_SECTORS - n) };
        uint8_t sum[4];
        uint8_t *p = out + MFM_GAP_LEAD_BYTES + (size_t)n * MFM_SECTOR_MFM_BYTES;
        p[0] = 0x44; p[1] = 0x89; p[2] = 0x44; p[3] = 0x89;      p += 4;
        mfm_split_odd_even(hl, 4, p);                             p += 8;
        mfm_split_odd_even(label, 16, p);                         p += 32;
        put_be32(sum, mfm_checksum(hl, 20));
        mfm_split_odd_even(sum, 4, p);                            p += 8;
        put_be32(sum, mfm_checksum(sd, MFM_SECTOR_DATA_BYTES));
        mfm_split_odd_even(sum, 4, p);                            p += 8;
        mfm_split_odd_even(sd, MFM_SECTOR_DATA_BYTES, p);
        /* The trailing 2 zero bytes split to 4 zero bytes: already zero. */
    }
    mfm_fill_clock_bits(out, MFM_TRACK_BYTES);
    return MFM_TRACK_BITS;
}
