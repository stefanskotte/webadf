// The PN532 backend: NXP UM0701-02 (PN532 User Manual, Rev. 02, 2007) on
// I2C, with AN10609_3 (PN532 C106 application note, Rev. 1.2) for the
// wake-up. It moves a tag's bytes and nothing else; every decision is the
// session's (nfc_reader_priv.h), exactly as for the Si512.
//
// The protocol, as used here:
//   - a command is one normal information frame host -> PN532,
//     00 00 FF LEN LCS D4 CMD ... DCS 00 (§6.2.1.1); the PN532 ACKs it
//     (00 00 FF 00 FF 00, §6.2.1.3), runs it, and answers with D5 CMD+1 ...
//     (§6.2.2);
//   - on I2C every read begins with a status byte, RDY = bit 0 (§6.2.4), and
//     the host polls it, a STOP after each not-ready byte. A ready frame must
//     be read whole in the SAME read: what a STOP leaves unread is lost. So a
//     wait here is one 1-byte read per step, and a frame is read in one go as
//     status + frame;
//   - the PN532 "may not acknowledge its own address immediately after
//     having finished a previous exchange" (§6.2.4): a NACKed address while
//     waiting is "not ready", not a fault. Every wait has a deadline instead;
//   - a garbled answer is asked for again with a NACK frame (§6.2.2.1 c);
//     a command that is not answered in time is aborted with an ACK frame
//     (§6.2.2.1 d) and sent again. LOSS_FAILS such failures in a row, with no
//     good answer between, and the chip is gone -- the PN532 counterpart of
//     the Si512's three failed transfers;
//   - wake-up: after power-up the chip is in LowVbat, and leaves it only on a
//     SAMConfiguration with Mode = Normal (§3.1.3.3, §3.1.3.8). On I2C the
//     first address it sees wakes it; it stretches SCL for ~1 ms (up to 2 ms
//     with some crystals) while its oscillator starts (§6.3.3.3 Fig 44,
//     AN10609 §2.5.2), which the I2C controller simply waits out. So the
//     first command of every session is SAMConfiguration 14 01;
//   - InListPassiveTarget retries "infinitely" by default (MxRtyPassiveActivation
//     0xFF, §7.3.1 CfgItem 5) -- with no tag it would never answer. The init
//     sets it to 0x00, one try, which with no tag ends in ~5 ms (§7.3.5) with
//     NbTg = 0 and the field off (§3.1.3.10);
//   - the field duty cycle (nfc_reader.c): the PN532 switches its field on
//     for InListPassiveTarget and leaves it on when it found a tag; every
//     return to idle then switches it off with RFConfiguration CfgItem 1
//     (§7.3.1), which also powers the tag down, so the next poll's SENS_REQ
//     (REQA, §7.3.5) finds it IDLE -- the Si512's WUPA-after-field-off;
//   - MIFARE Classic through InDataExchange Tg 1 (§7.3.8): 60 blk key[6]
//     uid[4] (auth A), 30 blk (READ, 16 bytes back), A0 blk data[16] (WRITE);
//     the status byte is §7.1's: 0x00 good, 0x14 a failed auth, 0x01 a tag
//     that did not answer.
#include "nfc_reader_priv.h"
#include <string.h>

// The ACK should follow a command at once; this covers the wake-up's SCL
// stretch (up to 2 ms, §6.3.3.3) many times over.
#define PN_ACK_MS     50
// The answer: InDataExchange to a MIFARE tag that has left gives up after its
// own 51.2 ms (§7.3.1 CfgItem 2, default 0x0A); InListPassiveTarget with one
// try takes ~5 ms with no tag (§7.3.5). Three times the longer.
#define PN_ANSWER_MS 150
#define PN_MAX_NACKS   2

// Read lengths, the status byte included: status, preamble, 00 FF, LEN, LCS,
// LEN bytes (TFI, the answer code, its data), DCS, postamble = LEN + 8.
#define RD_ACK     7                    // status + 00 00 FF 00 FF 00
#define RD_PLAIN  10                    // D5 xx: SAMConfiguration, RFConfiguration
#define RD_STATUS 11                    // D5 41 status: auth, WRITE
#define RD_READ   27                    // D5 41 status data[16]
#define RD_LIST   20                    // D5 4B NbTg Tg SENS(2) SEL len uid[4]; longer is re-read

// ---- The codec ------------------------------------------------------------------

int pn532_frame(uint8_t *out, int cap, const uint8_t *data, int n) {
    if (n < 1 || n > 254 || cap < n + 8) return -1;
    int k = 0;
    out[k++] = 0x00;                     // preamble
    out[k++] = 0x00;                     // start code
    out[k++] = 0xFF;
    out[k++] = (uint8_t)(n + 1);         // LEN: TFI + data
    out[k++] = (uint8_t)(0x100 - (n + 1));   // LCS: LEN + LCS = 0 (mod 256)
    uint8_t sum = 0xD4;
    out[k++] = 0xD4;                     // TFI: host -> PN532
    for (int i = 0; i < n; i++) { out[k++] = data[i]; sum = (uint8_t)(sum + data[i]); }
    out[k++] = (uint8_t)(0x100 - sum);   // DCS: TFI + data + DCS = 0 (mod 256)
    out[k++] = 0x00;                     // postamble
    return k;
}

pn_parse_t pn532_parse(const uint8_t *b, int n, int *at, int *len, int *need) {
    if (n < 1) return PN_BAD;
    if (!(b[0] & 0x01)) return PN_NOT_READY;
    // The start code 00 FF ends a preamble of any length (§6.2.1.6).
    int s = -1;
    for (int i = 1; i + 1 < n; i++)
        if (b[i] == 0x00 && b[i + 1] == 0xFF) { s = i; break; }
    if (s < 0 || s + 3 >= n) return PN_BAD;
    uint8_t L = b[s + 2], C = b[s + 3];
    if (L == 0x00 && C == 0xFF) return PN_ACK;
    // A bad LCS, the NACK (FF 00) and the extended frame (FF FF, §6.2.1.2 --
    // never sent for an answer this short) all fail here; the syntax error
    // frame (LEN 1, §6.2.1.5) fails the next line.
    if ((uint8_t)(L + C) != 0 || L < 2) return PN_BAD;
    int t = s + 4;                       // TFI
    int dcs = t + L;
    if (dcs + 1 >= n) {                  // DCS or postamble not in this read
        *need = dcs + 2;
        return PN_SHORT;
    }
    if (b[t] != 0xD5) return PN_BAD;
    uint8_t sum = 0;
    for (int i = t; i <= dcs; i++) sum = (uint8_t)(sum + b[i]);
    if (sum != 0) return PN_BAD;
    *at = t;
    *len = L;
    return PN_OK;
}

// ---- Transfers, counted ----------------------------------------------------------------
//
// A status poll is one op. A frame transfer is the only transfer of its step
// and uses up the rest of the budget (nfc_reader.h NFC_MAX_OPS_PER_STEP), so
// a step never puts more than one frame on the bus.

static bool frame_slot(const nfc_reader_t *r) { return r->ops == 0; }

static bool fwr(nfc_reader_t *r, const uint8_t *b, int n) {
    r->ops = r->max_ops;
    return r->fbus.wr(r->fbus.ctx, b, n);
}

static bool frd(nfc_reader_t *r, uint8_t *b, int n) {
    if (n == 1) r->ops++;
    else r->ops = r->max_ops;
    return r->fbus.rd(r->fbus.ctx, b, n);
}

// ---- The command subroutine (ST_PN_CMD) ---------------------------------------------------

enum { PC_SEND, PC_ACK_WAIT, PC_ACK_READ, PC_ANS_WAIT, PC_ANS_READ, PC_NACK, PC_ABORT };

// One command: r->tx[0..tx_len) after the TFI. Hands back r->status: MI_OK
// with the answer's data at pn_buf[pn_at], rx_n bytes; MI_ERR for an answer
// too long for the buffer (a card, not the chip, so not a failure). A chip
// that does not answer never returns from here: the subroutine aborts and
// resends, and the LOSS_FAILS-th failure ends the session.
static void pn_call(nfc_reader_t *r, const uint8_t *data, int n, int rd_len) {
    memcpy(r->tx, data, (size_t)n);
    r->tx_len = n;
    r->pn_cmd = data[0];
    r->pn_rd_len = rd_len;
    r->pn_wait_ms = PN_ANSWER_MS;
    r->pn_nacks = 0;
    r->pn_t = r->now_ms();
    nfc_call(r, ST_PN_CMD);
}

// The probe found nothing that speaks PN532: back to ABSENT, as if the
// presence check had ended at the Si512. No event -- nothing was PRESENT.
static void give_up(nfc_reader_t *r) {
    r->probing = false;
    r->chip = NFC_CHIP_NONE;
    nfc_go(r, ST_ABSENT);
    r->t0 = r->t_probe;
    r->checked_once = true;
}

static void cmd_failed(nfc_reader_t *r) {
    if (++r->pn_bad >= LOSS_FAILS) {
        if (r->probing) give_up(r);
        else nfc_lose_chip(r);
        return;
    }
    r->pc = PC_ABORT;
}

static bool late(const nfc_reader_t *r, uint32_t limit) {
    return r->now_ms() - r->pn_t > limit;
}

static bool st_cmd(nfc_reader_t *r) {
    static const uint8_t ACK[6]  = { 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00 };
    static const uint8_t NACK[6] = { 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00 };
    int at = 0, len = 0, need = 0;
    switch (r->pc) {
    case PC_SEND: {
        if (!frame_slot(r)) return false;
        int n = pn532_frame(r->pn_buf, (int)sizeof r->pn_buf, r->tx, r->tx_len);
        if (fwr(r, r->pn_buf, n)) {
            r->pn_t = r->now_ms();
            r->pc = PC_ACK_WAIT;
            return false;
        }
        // Nothing acknowledged 0x24 at all: while probing, there is no PN532.
        if (r->probing) give_up(r);
        else if (late(r, PN_ACK_MS)) cmd_failed(r);
        return false;
    }
    case PC_ACK_WAIT:
    case PC_ANS_WAIT: {
        uint8_t st = 0;
        if (frd(r, &st, 1) && (st & 0x01)) { r->pc++; return true; }
        if (late(r, r->pc == PC_ACK_WAIT ? PN_ACK_MS : r->pn_wait_ms)) cmd_failed(r);
        return false;
    }
    case PC_ACK_READ: {
        if (!frame_slot(r)) return false;
        if (!frd(r, r->pn_buf, RD_ACK)) { r->pc = PC_ACK_WAIT; return false; }
        pn_parse_t p = pn532_parse(r->pn_buf, RD_ACK, &at, &len, &need);
        if (p == PN_NOT_READY) { r->pc = PC_ACK_WAIT; return false; }
        if (p != PN_ACK) { cmd_failed(r); return false; }   // the frame was not taken
        r->pn_t = r->now_ms();
        r->pc = PC_ANS_WAIT;
        return false;
    }
    case PC_ANS_READ: {
        if (!frame_slot(r)) return false;
        int n = r->pn_rd_len;
        if (!frd(r, r->pn_buf, n)) { r->pc = PC_ANS_WAIT; return false; }
        pn_parse_t p = pn532_parse(r->pn_buf, n, &at, &len, &need);
        if (p == PN_OK && r->pn_buf[at + 1] == (uint8_t)(r->pn_cmd + 1)) {
            r->pn_at = at + 2;                   // past TFI and the answer code
            r->rx_n = len - 2;
            r->status = MI_OK;
            r->pn_bad = 0;
            nfc_ret(r);
            return true;
        }
        if (p == PN_NOT_READY) { r->pc = PC_ANS_WAIT; return false; }
        if (p == PN_SHORT && need > NFC_PN532_BUF) {
            // Longer than any answer we can use (a 10-byte UID with a long
            // ATS): refused whole, never written past pn_buf.
            r->status = MI_ERR;
            r->pn_bad = 0;
            nfc_ret(r);
            return true;
        }
        if (p == PN_SHORT) r->pn_rd_len = need;  // read it again, whole
        if (r->pn_nacks < PN_MAX_NACKS) { r->pc = PC_NACK; return false; }
        cmd_failed(r);
        return false;
    }
    case PC_NACK:
        if (!frame_slot(r)) return false;
        if (!fwr(r, NACK, 6)) {
            if (late(r, PN_ACK_MS)) cmd_failed(r);
            return false;
        }
        r->pn_nacks++;
        r->pn_t = r->now_ms();
        r->pc = PC_ANS_WAIT;
        return false;
    default:                                     // PC_ABORT, then send again
        if (!frame_slot(r)) return false;
        (void)fwr(r, ACK, 6);                    // a gone chip will not hear it either
        r->pn_nacks = 0;
        r->pn_t = r->now_ms();
        r->pc = PC_SEND;
        return false;
    }
}

// ---- The states ------------------------------------------------------------------------------

static const uint8_t *answer(const nfc_reader_t *r) { return r->pn_buf + r->pn_at; }

static bool st_init(nfc_reader_t *r) {
    static const uint8_t SAM[2]     = { 0x14, 0x01 };                    // Normal mode (§7.2.10)
    static const uint8_t RETRIES[5] = { 0x32, 0x05, 0xFF, 0x01, 0x00 };  // MxRtyATR, PSL defaults; one passive try
    static const uint8_t FIELD0[3]  = { 0x32, 0x01, 0x00 };              // RF field off, AutoRFCA off
    switch (r->phase) {
    case 0:
        r->phase = 1;
        pn_call(r, SAM, 2, RD_PLAIN);
        return true;
    case 1:
        if (r->status != MI_OK) { give_up(r); return false; }
        // It answered SAMConfiguration: a PN532, awake and in normal mode.
        r->probing = false;
        nfc_chip_found(r);
        r->phase = 2;
        pn_call(r, RETRIES, 5, RD_PLAIN);
        return true;
    case 2:
        r->phase = 3;
        pn_call(r, FIELD0, 3, RD_PLAIN);
        return true;
    default:
        r->pn_field = false;
        nfc_enter_idle(r, true);
        return true;
    }
}

static bool st_idle(nfc_reader_t *r) {
    static const uint8_t FIELD0[3] = { 0x32, 0x01, 0x00 };
    switch (r->phase) {
    case 0:                                      // field off, if a found tag left it on
        if (!r->pn_field) { r->phase = 2; return true; }
        r->phase = 1;
        pn_call(r, FIELD0, 3, RD_PLAIN);
        return true;
    case 1:
        if (r->status == MI_OK) r->pn_field = false;
        r->phase = 2;
        return true;
    default:                                     // wait for the poll
        if (!nfc_poll_due(r)) return false;
        nfc_go(r, ST_PN_POLL);
        return true;
    }
}

static bool st_poll(nfc_reader_t *r) {
    static const uint8_t LIST[3] = { 0x4A, 0x01, 0x00 };   // MaxTg 1, 106 kbps type A (§7.3.5)
    if (r->phase == 0) {
        r->phase = 1;
        r->pn_field = true;                      // on for the poll; off after if no tag
        pn_call(r, LIST, 3, RD_LIST);
        return true;
    }
    const uint8_t *p = answer(r);
    int n = r->rx_n;
    if (r->status != MI_OK || n < 1) { nfc_empty_poll(r); return true; }
    if (p[0] == 0) {                             // NbTg 0: no tag, and the field is off (§3.1.3.10)
        r->pn_field = false;
        nfc_empty_poll(r);
        return true;
    }
    // TargetData, 106 kbps type A: Tg SENS_RES[2] SEL_RES NFCIDLength NFCID1[]
    // [ATS] (§7.3.5). Anything shorter than it says is garbage: no tag.
    int idlen = n >= 6 ? p[5] : 0;
    if (p[1] != 1 || (idlen != 4 && idlen != 7 && idlen != 10) || 6 + idlen > n) {
        nfc_empty_poll(r);
        return true;
    }
    if (idlen == 4) {
        memcpy(r->uid, p + 6, 4);
    } else {
        // As the Si512's cascade level 1 sees it: the cascade tag, then the
        // first three UID bytes -- so a tag has the same UID on either chip.
        r->uid[0] = 0x88;
        memcpy(r->uid + 1, p + 6, 3);
    }
    r->sak = p[4];
    if (!nfc_arrival(r)) return true;            // the held tag: back to idle
    // SEL_RES bit 3: MIFARE Classic, which has a 4-byte UID here. Anything
    // else has no sector 1 to read: "not ours", as on the Si512.
    if (idlen != 4 || !(r->sak & 0x08)) { nfc_finish(r, NFC_EV_NOT_OURS, NULL); return true; }
    nfc_go(r, ST_PN_AUTH);
    return true;
}

static bool st_auth(nfc_reader_t *r) {
    if (r->phase == 0) {
        uint8_t c[14] = { 0x40, 0x01, 0x60, FIRST_BLOCK, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
        memcpy(c + 10, r->uid, 4);
        r->phase = 1;
        pn_call(r, c, 14, RD_STATUS);
        return true;
    }
    // Status 0x00 is the only proof; 0x14 is a wrong key, 0x01 a tag that
    // left during the auth -- both "locked", as on the Si512.
    bool ok = r->status == MI_OK && r->rx_n >= 1 && answer(r)[0] == 0x00;
    nfc_auth_done(r, ok);
    if (ok) nfc_go(r, r->writing ? ST_PN_WRITE : ST_PN_READ);
    return true;
}

static bool st_read(nfc_reader_t *r) {
    if (r->phase == 0) {
        uint8_t c[4] = { 0x40, 0x01, 0x30, (uint8_t)r->block };
        r->phase = 1;
        pn_call(r, c, 4, RD_READ);
        return true;
    }
    const uint8_t *p = answer(r);
    if (r->status != MI_OK || r->rx_n != 17 || p[0] != 0x00) { nfc_moved(r); return true; }
    if (nfc_block_in(r, p + 1, r->state == ST_PN_READBACK)) r->phase = 0;
    return true;
}

static bool st_write(nfc_reader_t *r) {
    if (r->phase == 0) {
        uint8_t c[20] = { 0x40, 0x01, 0xA0, (uint8_t)r->block };
        memcpy(c + 4, nfc_block_out(r), 16);
        r->phase = 1;
        pn_call(r, c, 20, RD_STATUS);
        return true;
    }
    if (r->status != MI_OK || r->rx_n < 1 || answer(r)[0] != 0x00) { nfc_moved(r); return true; }
    if (nfc_block_written(r)) { r->phase = 0; return true; }
    nfc_go(r, ST_PN_READBACK);
    return true;
}

// ---- The backend's entry points ------------------------------------------------------------

void pn532_probe(nfc_reader_t *r) {
    r->chip = NFC_CHIP_PN532;
    r->probing = true;
    r->t_probe = r->t0;                          // the presence check's time (st_absent)
    r->pn_bad = 0;
    r->pn_field = false;
    nfc_go(r, ST_PN_INIT);
}

bool pn532_handle(nfc_reader_t *r) {
    switch ((st_t)r->state) {
    case ST_PN_INIT:     return st_init(r);
    case ST_PN_IDLE:     return st_idle(r);
    case ST_PN_POLL:     return st_poll(r);
    case ST_PN_AUTH:     return st_auth(r);
    case ST_PN_READ:
    case ST_PN_READBACK: return st_read(r);
    case ST_PN_WRITE:    return st_write(r);
    case ST_PN_CMD:      return st_cmd(r);
    default:             return false;
    }
}
