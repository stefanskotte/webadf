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
//     that did not answer;
//   - an NFC Forum Type 2 tag (NTAG213/215/216) is a "Mifare" target to the
//     PN532 too (§7.3.8, "Mifare card": "Refer to Mifare cards (Classic and
//     Ultralight) documentation"), with no auth: 30 page (READ, four pages,
//     16 bytes back) and A2 page data[4] -- "0xA2 4 bytes writing" in
//     §7.3.8's list of Mifare command bytes. Not A0: on a Type 2 tag 0xA0 is
//     the COMPATIBILITY WRITE, which takes 16 bytes and writes only the first
//     4. The manual does not say which status a Type 2 NAK becomes; 0x01 (no
//     answer, §7.1) is read as "moved", any other non-zero as "locked";
//   - InRelease 52 Tg (§7.3.11): "the PN532 erases all the information relative
//     to" the target, sends HLTA to a MIFARE card (Table 24), and, with no
//     activated target left, returns to Standby -- field off. Sent with Tg 00
//     (all targets) once at init (a warm reset of the RP2350 does not reset the
//     PN532, so a target from the previous boot may still be listed) and after
//     every poll that found a target, before the next InListPassiveTarget. §7.3.5
//     says a new InListPassiveTarget already loses the old targets' information;
//     the release is belt and braces against stale state (2026-10-19: a batch of
//     NTAG215s read "locked" on a PN532 until one was erased elsewhere). HLTA
//     leaves a tag on the reader HALTed, which REQA does not wake -- the field
//     going off (Standby, and the field-off below it) resets it to IDLE, so the
//     next poll still finds it;
//   - a failed exchange's status byte and command go into the event
//     (pn_err_status / pn_err_cmd), for the server; `why` is unchanged.
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
// D5 4B NbTg Tg SENS(2) SEL len uid[7]: a 7-byte UID (an NTAG, the commonest
// sticker) is 23 bytes, read whole the first time; only longer (a 10-byte UID,
// an ATS) takes the NACK re-read.
#define RD_LIST   24

// ---- The bus clock -------------------------------------------------------------------
//
// The boot probe (i2c_probe.c) puts i2c1 at 100 kHz, and only a display that
// answers raises it (ssd1306_selftest). At 100 kHz a PN532 frame is ~2.6 ms
// of core0 and the 64-byte re-read ~5.8 ms -- inside PaulaNET's SIDE-edge
// window (the Amiga reads 1.0-5.4 ms after the edge). The PN532 supports
// 400 kHz ("fast mode (up to 400 KHz CLK)", UM0701-02 §6.2.4), so once one has
// answered SAMConfiguration the reader asks for it (nfc_frame_bus_t set_hz),
// as ssd1306_selftest does once a panel has answered. Nothing sets i2c1
// slower after boot: i2c_init is called only by i2c_probe_bus, at boot.
//
// The worst step then, (bytes + the address byte) x 9 bits / 400 kHz:
//   - the 64-byte re-read (a 10-byte UID or an ATS card): 1.46 ms;
//   - an ordinary frame, 28 bytes written or 27 read: ~0.65 ms;
//   - a status poll: 45 us.
// Until the first answer -- the SAMConfiguration probe, its ACK and its
// answer, 10, 7 and 10 bytes -- frames run at the bus's 100 kHz, ~1 ms each
// (test_nfc_pn532.c pins both: at most three slow frames, no step over 1.5 ms).
#define PN_BUS_HZ 400000

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

// A failed InDataExchange: the status byte the chip answered and the command byte that drew it, for the event
// (nfc_finish). Nothing when there is no status to keep (the command itself was not answered).
static void pn_detail(nfc_reader_t *r, uint8_t cmd) {
    if (r->status != MI_OK || r->rx_n < 1) return;
    r->pn_err_status = answer(r)[0];
    r->pn_err_cmd = cmd;
}

static bool st_init(nfc_reader_t *r) {
    static const uint8_t SAM[2]     = { 0x14, 0x01 };                    // Normal mode (§7.2.10)
    static const uint8_t RETRIES[5] = { 0x32, 0x05, 0xFF, 0x01, 0x00 };  // MxRtyATR, PSL defaults; one passive try
    static const uint8_t FIELD0[3]  = { 0x32, 0x01, 0x00 };              // RF field off, AutoRFCA off
    static const uint8_t RELEASE[2] = { 0x52, 0x00 };                    // InRelease all (§7.3.11)
    switch (r->phase) {
    case 0:
        r->phase = 1;
        pn_call(r, SAM, 2, RD_PLAIN);
        return true;
    case 1:
        if (r->status != MI_OK) { give_up(r); return false; }
        // It answered SAMConfiguration: a PN532, awake and in normal mode.
        // From here every frame runs at 400 kHz ("The bus clock" above).
        r->probing = false;
        if (r->fbus.set_hz) r->fbus.set_hz(r->fbus.ctx, PN_BUS_HZ);
        r->t_si512 = r->now_ms();
        nfc_chip_found(r);
        r->phase = 2;
        pn_call(r, RETRIES, 5, RD_PLAIN);
        return true;
    case 2:
        r->phase = 3;
        pn_call(r, RELEASE, 2, RD_STATUS);       // a target left listed by the previous boot
        return true;
    case 3:
        r->pn_target = false;
        r->phase = 4;
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
    static const uint8_t RELEASE[2] = { 0x52, 0x00 };   // InRelease all (§7.3.11)
    switch (r->phase) {
    case 0:                                      // release a found target first, whatever happened to it
        if (!r->pn_target) { r->phase = 2; return true; }
        r->phase = 1;
        pn_call(r, RELEASE, 2, RD_STATUS);
        return true;
    case 1:
        // Answered (any status): the target's logical number is freed. Not answered: the command subroutine
        // already counted it, and the next found target is released again.
        if (r->status == MI_OK) r->pn_target = false;
        r->phase = 2;
        return true;
    case 2:                                      // field off, if a found tag left it on
        if (!r->pn_field) { r->phase = 4; return true; }
        r->phase = 3;
        pn_call(r, FIELD0, 3, RD_PLAIN);
        return true;
    case 3:
        if (r->status == MI_OK) r->pn_field = false;
        r->phase = 4;
        return true;
    default:                                     // wait for the poll
        if (nfc_si512_back(r)) return false;     // the preferred chip answered again
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
    r->pn_target = true;                         // NbTg >= 1: listed until InRelease (st_idle)
    int idlen = n >= 6 ? p[5] : 0;
    if (p[1] != 1 || (idlen != 4 && idlen != 7 && idlen != 10) || 6 + idlen > n) {
        nfc_empty_poll(r);
        return true;
    }
    // The whole UID, as the Si512 assembles it from its two cascade levels --
    // so a tag has the same UID on either chip. A triple-size (10-byte) UID
    // keeps its first seven, and is refused below.
    nfc_uid_set(r, p + 6, idlen == 4 ? 4 : 7);
    r->sak = p[4];                               // the final SEL_RES (SAK)
    if (!nfc_arrival(r)) return true;            // the held tag: back to idle
    if (idlen == 10) { nfc_finish(r, NFC_EV_NOT_SUPPORTED, NULL); return true; }
    // A MIFARE Classic (4-byte UID, SAK bit 3) goes on to key A; a Type 2 tag
    // (7-byte UID, SAK 00) straight to its pages; anything else is "not
    // supported", as on the Si512 (nfc_tag_selected).
    if (!nfc_tag_selected(r, r->sak)) return true;
    if (r->kind == NFC_KIND_CLASSIC) nfc_go(r, ST_PN_AUTH);
    else nfc_go(r, r->writing ? ST_PN_WRITE : ST_PN_READ);
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
    if (!ok) pn_detail(r, 0x60);
    nfc_auth_done(r, ok);
    if (ok) nfc_go(r, r->writing ? ST_PN_WRITE : ST_PN_READ);
    return true;
}

static bool st_read(nfc_reader_t *r) {
    if (r->phase == 0) {
        uint8_t c[4] = { 0x40, 0x01, 0x30, nfc_read_addr(r) };   // a block, or a Type 2 tag's four pages
        r->phase = 1;
        pn_call(r, c, 4, RD_READ);
        return true;
    }
    const uint8_t *p = answer(r);
    if (r->status != MI_OK || r->rx_n != 17 || p[0] != 0x00) { pn_detail(r, 0x30); nfc_moved(r); return true; }
    if (nfc_block_in(r, p + 1, r->state == ST_PN_READBACK)) r->phase = 0;
    return true;
}

// A Type 2 page: 40 01 A2 page d0..d3 (§7.3.8 "0xA2 4 bytes writing"), the
// only pages ever sent being 4-15 (nfc_t2_page).
static bool st_write_t2(nfc_reader_t *r) {
    if (r->phase == 0) {
        int pg = nfc_t2_page(r);
        if (pg < 0) { nfc_moved(r); return true; }   // cannot happen; nothing is sent
        uint8_t c[8] = { 0x40, 0x01, 0xA2, (uint8_t)pg };
        memcpy(c + 4, nfc_t2_page_out(r), 4);
        r->phase = 1;
        pn_call(r, c, 8, RD_STATUS);
        return true;
    }
    if (r->status != MI_OK || r->rx_n < 1) { nfc_moved(r); return true; }
    uint8_t st = answer(r)[0] & 0x3F;            // §7.1: the error code is bits 0-5
    if (st != 0x00) pn_detail(r, 0xA2);
    if (st == 0x01) { nfc_moved(r); return true; }           // no answer: the tag left
    if (st != 0x00) { nfc_write_refused(r); return true; }   // it answered, and refused
    if (nfc_t2_page_written(r)) { r->phase = 0; return true; }
    nfc_go(r, ST_PN_READBACK);
    return true;
}

static bool st_write(nfc_reader_t *r) {
    if (r->kind == NFC_KIND_T2) return st_write_t2(r);
    if (r->phase == 0) {
        uint8_t c[20] = { 0x40, 0x01, 0xA0, (uint8_t)r->block };
        memcpy(c + 4, nfc_block_out(r), 16);
        r->phase = 1;
        pn_call(r, c, 20, RD_STATUS);
        return true;
    }
    if (r->status != MI_OK || r->rx_n < 1 || answer(r)[0] != 0x00) { pn_detail(r, 0xA0); nfc_moved(r); return true; }
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
    r->pn_field = r->pn_target = false;
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
