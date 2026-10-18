#include "pn532_fake.h"
#include <string.h>

// Deliberately NOT sharing nfc_pn532.c's codec: a mistake there must
// disagree with this file, not agree with it.

#define ACK_MS        1    // the ACK is ready this long after the command
#define ANSWER_MS     2    // a quick answer (configuration, a tag that answers)
#define LIST_TRY_MS   5    // one InListPassiveTarget try: "timeout control of ~5 ms" (§7.3.5)
#define MIFARE_TO_MS 52    // InDataExchange to a silent MIFARE tag: 51.2 ms (§7.3.1 CfgItem 2)

static uint32_t now(const pn532_fake_t *f) { return *f->clock; }

void pn532_fake_init(pn532_fake_t *f, const uint32_t *clock) {
    memset(f, 0, sizeof *f);
    f->chip_present = true;
    f->tag_present = true;
    static const uint8_t uid[4] = { 0xDE, 0xAD, 0xBE, 0xEF };
    memcpy(f->uid, uid, 4);
    f->uid_len = 4;
    f->sak = 0x08;
    f->tag_leaves_after_cmds = -1;
    f->vanish_after_xfers = -1;
    f->retries_passive = 0xFF;
    f->clock = clock;
    f->bus_hz = 100000;
}

static void set_field(pn532_fake_t *f, bool on) {
    if (on && !f->field) f->field_on_at = now(f);
    if (!on && f->field) f->field_on_ms += now(f) - f->field_on_at;
    f->field = on;
    if (!on) f->tag_state = 0;            // the tag loses power: back to IDLE
}

uint32_t pn532_fake_field_on_ms(const pn532_fake_t *f) {
    return f->field_on_ms + (f->field ? now(f) - f->field_on_at : 0);
}

void pn532_fake_step_begin(pn532_fake_t *f) { f->step_frames = 0; f->step_us = 0; }

// An answer frame PN532 -> host: 00 00 FF LEN LCS D5 cmd+1 data DCS 00.
static int build(uint8_t *out, uint8_t code, const uint8_t *d, int n) {
    int len = n + 2;                      // TFI + code + data
    int k = 0;
    out[k++] = 0x00; out[k++] = 0x00; out[k++] = 0xFF;
    out[k++] = (uint8_t)len;
    out[k++] = (uint8_t)(0x100 - len);
    uint8_t sum = 0xD5 + code;
    out[k++] = 0xD5; out[k++] = code;
    for (int i = 0; i < n; i++) { out[k++] = d[i]; sum += d[i]; }
    out[k++] = (uint8_t)(0x100 - sum);
    out[k++] = 0x00;
    return k;
}

static void answer(pn532_fake_t *f, uint8_t code, const uint8_t *d, int n, uint32_t delay) {
    f->ans_n = build(f->ans, code, d, n);
    memcpy(f->last, f->ans, (size_t)f->ans_n);
    f->last_n = f->ans_n;
    if (f->bad_len_next > 0) {            // LEN lies (its LCS agrees); the body does not change
        f->ans[3] = (uint8_t)f->bad_len_next;
        f->ans[4] = (uint8_t)(0x100 - f->bad_len_next);
        f->bad_len_next = 0;
    } else if (f->garble_next > 0) {
        f->ans[f->ans_n - 2] ^= 0x5A;     // the DCS
        f->garble_next--;
    }
    f->ans_delay = delay;
    f->ans_pending = !f->never_answer;
}

static void status_only(pn532_fake_t *f, uint8_t code, uint8_t st, uint32_t delay) {
    answer(f, code, &st, 1, delay);
}

static void list_passive(pn532_fake_t *f, const uint8_t *p, int n) {
    if (n != 2 || p[0] != 0x01 || p[1] != 0x00) {      // MaxTg 1, 106 kbps type A only
        static const uint8_t none = 0;
        answer(f, 0x4B, &none, 1, ANSWER_MS);
        return;
    }
    set_field(f, true);
    if (f->tag_present && f->tag_state == 0) {          // REQA: an IDLE tag only
        uint8_t d[90];
        int k = 0;
        d[k++] = 1;                                     // NbTg
        d[k++] = 1;                                     // Tg
        d[k++] = 0x00; d[k++] = 0x04;                   // SENS_RES
        d[k++] = f->sak;
        d[k++] = (uint8_t)f->uid_len;
        memcpy(d + k, f->uid, (size_t)f->uid_len);
        k += f->uid_len;
        if (f->ats_len > 0) {
            d[k++] = (uint8_t)f->ats_len;
            for (int i = 1; i < f->ats_len; i++) d[k++] = (uint8_t)(0x70 + i);
        }
        f->tag_state = 2;
        f->ilpt_found++;
        answer(f, 0x4B, d, k, ANSWER_MS);
        return;
    }
    if (f->retries_passive == 0xFF) {                   // retries forever: no answer, field on
        f->ans_pending = false;
        return;
    }
    static const uint8_t none = 0;
    uint32_t tries = (uint32_t)LIST_TRY_MS * (uint32_t)(f->retries_passive + 1);
    answer(f, 0x4B, &none, 1, tries);
    set_field(f, false);                                 // §3.1.3.10: off once the tries are over,
    f->field_on_ms += tries;                             // having been on for all of them
}

static void exchange(pn532_fake_t *f, const uint8_t *p, int n) {
    static const uint8_t key[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
    if (n < 1 || p[0] != 0x01) { status_only(f, 0x41, 0x27, ANSWER_MS); return; }
    const uint8_t *c = p + 1;
    int m = n - 1;
    bool alive = f->tag_present && f->field && f->tag_state >= 2;
    if (!alive) { f->tag_state = 0; status_only(f, 0x41, 0x01, MIFARE_TO_MS); return; }
    if (m == 12 && c[0] == 0x60 && c[1] >= 4 && c[1] <= 7) {
        if (!f->locked && memcmp(c + 2, key, 6) == 0 && memcmp(c + 8, f->uid, 4) == 0) {
            f->tag_state = 3;
            status_only(f, 0x41, 0x00, ANSWER_MS);
        } else {
            f->tag_state = 0;                           // a failed auth: the tag drops out
            status_only(f, 0x41, 0x14, ANSWER_MS);
        }
        return;
    }
    if (f->tag_state != 3 || m < 2 || c[1] < 4 || c[1] > 7) {
        f->tag_state = 0;
        status_only(f, 0x41, 0x01, MIFARE_TO_MS);
        return;
    }
    if (m == 2 && c[0] == 0x30) {
        uint8_t d[17] = { 0x00 };
        if (c[1] <= 6) memcpy(d + 1, f->sector1 + (c[1] - 4) * 16, 16);
        if (f->flip_next_read) { d[4] ^= 0x10; f->flip_next_read = false; }
        f->reads++;
        answer(f, 0x41, d, 17, ANSWER_MS);
        return;
    }
    if (m == 18 && c[0] == 0xA0) {
        if (c[1] == 7) f->trailer_writes++;
        else memcpy(f->sector1 + (c[1] - 4) * 16, c + 2, 16);
        status_only(f, 0x41, 0x00, ANSWER_MS);
        return;
    }
    status_only(f, 0x41, 0x01, MIFARE_TO_MS);
}

static void command(pn532_fake_t *f, uint8_t code, const uint8_t *p, int n) {
    f->cmds[code]++;
    f->ncmds++;
    if (f->tag_leaves_after_cmds >= 0 && f->ncmds > f->tag_leaves_after_cmds) {
        f->tag_present = false;
        f->tag_state = 0;
    }
    // The ACK first (§6.2.2), then the answer behind it.
    static const uint8_t ack[6] = { 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00 };
    memcpy(f->q, ack, 6);
    f->q_n = 6;
    f->q_is_ack = true;
    f->q_at = now(f) + ACK_MS;
    f->ans_pending = false;
    switch (code) {
    case 0x14:                                           // SAMConfiguration
        if (n >= 1 && p[0] == 0x01) f->sam_done = true;
        answer(f, 0x15, NULL, 0, ANSWER_MS);
        break;
    case 0x32:                                           // RFConfiguration
        if (n == 2 && p[0] == 0x01) set_field(f, (p[1] & 0x01) != 0);
        if (n == 4 && p[0] == 0x05) f->retries_passive = p[3];
        answer(f, 0x33, NULL, 0, ANSWER_MS);
        break;
    case 0x4A: list_passive(f, p, n); break;
    case 0x40: exchange(f, p, n); break;
    case 0x52:                                           // InRelease: HLTA, field off
        if (f->tag_state >= 2) f->tag_state = 1;
        set_field(f, false);
        status_only(f, 0x53, 0x00, ANSWER_MS);
        break;
    case 0x02: {                                         // GetFirmwareVersion
        static const uint8_t v[4] = { 0x32, 0x01, 0x06, 0x07 };
        answer(f, 0x03, v, 4, ANSWER_MS);
        break;
    }
    default: {                                           // the syntax error frame (§6.2.1.5)
        static const uint8_t err[8] = { 0x00, 0x00, 0xFF, 0x01, 0xFF, 0x7F, 0x81, 0x00 };
        memcpy(f->ans, err, 8);
        f->ans_n = 8;
        f->ans_delay = ANSWER_MS;
        f->ans_pending = true;
        break;
    }
    }
}

static bool transfer(pn532_fake_t *f, int n) {
    int idx = f->xfers++;
    if (n > f->max_xfer) f->max_xfer = n;
    if (n != 1 && ++f->step_frames > f->max_step_frames) f->max_step_frames = f->step_frames;
    if (n != 1 && f->bus_hz < 400000) f->slow_frames++;
    f->step_us += (uint32_t)(((uint64_t)(n + 1) * 9u * 1000000u) / f->bus_hz);
    if (f->step_us > f->max_step_us) f->max_step_us = f->step_us;
    if (!f->chip_present) return false;
    return !(f->vanish_after_xfers >= 0 && idx >= f->vanish_after_xfers);
}

static bool fake_wr(void *ctx, const uint8_t *b, int n) {
    pn532_fake_t *f = ctx;
    if (!transfer(f, n)) return false;
    // Find the start code; the preamble may be any length (§6.2.4.2).
    int i = 0;
    while (i + 1 < n && !(b[i] == 0x00 && b[i + 1] == 0xFF)) i++;
    if (i + 3 >= n) return true;                         // nothing we can read: ignored
    uint8_t len = b[i + 2], lcs = b[i + 3];
    if (len == 0x00 && lcs == 0xFF) {                    // ACK: abort (§6.2.2.1 d)
        f->host_acks++;
        f->q_n = 0;
        f->ans_pending = false;
        return true;
    }
    if (len == 0xFF && lcs == 0x00) {                    // NACK: the last answer again
        f->host_nacks++;
        if (f->last_n > 0) {
            memcpy(f->q, f->last, (size_t)f->last_n);
            f->q_n = f->last_n;
            f->q_is_ack = false;
            f->q_at = now(f) + ACK_MS;
        }
        return true;
    }
    if ((uint8_t)(len + lcs) != 0 || len < 2 || i + 4 + len + 1 > n) return true;  // no ACK
    const uint8_t *d = b + i + 4;
    uint8_t sum = 0;
    for (int k = 0; k <= len; k++) sum += d[k];          // TFI .. DCS
    if (sum != 0 || d[0] != 0xD4) return true;           // no ACK (§6.2.2.1 b)
    if (!f->sam_done && d[1] != 0x14) return true;       // LowVbat: SAMConfiguration first
    command(f, d[1], d + 2, len - 2);
    return true;
}

static bool fake_rd(void *ctx, uint8_t *b, int n) {
    pn532_fake_t *f = ctx;
    if (n == 1) f->status_reads++;
    if (!transfer(f, n)) return false;
    memset(b, 0x00, (size_t)n);
    if (f->q_n == 0 || now(f) < f->q_at) {               // RDY = 0; the rest is noise
        for (int k = 1; k < n; k++) b[k] = 0xA5;
        return true;
    }
    b[0] = 0x01;
    if (n == 1) return true;                             // a status poll leaves the frame waiting
    int c = f->q_n < n - 1 ? f->q_n : n - 1;
    memcpy(b + 1, f->q, (size_t)c);                      // the unread rest is lost (§6.2.4)
    bool was_ack = f->q_is_ack;
    f->q_n = 0;
    if (was_ack && f->ans_pending) {
        memcpy(f->q, f->ans, (size_t)f->ans_n);
        f->q_n = f->ans_n;
        f->q_is_ack = false;
        f->q_at = now(f) + f->ans_delay;
        f->ans_pending = false;
    }
    return true;
}

// The bus clock the reader asks for (nfc_frame_bus_t set_hz). It is the
// whole i2c1's clock on the board, so it is recorded, not judged here.
static void fake_set_hz(void *ctx, uint32_t hz) {
    pn532_fake_t *f = ctx;
    f->hz_requests++;
    if (f->lowest_hz_asked == 0 || hz < f->lowest_hz_asked) f->lowest_hz_asked = hz;
    f->bus_hz = hz;
}

nfc_frame_bus_t pn532_fake_bus(pn532_fake_t *f) {
    nfc_frame_bus_t b = { fake_wr, fake_rd, fake_set_hz, f };
    return b;
}
