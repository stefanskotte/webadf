// The Si512 backend: the vendor's SI512_App.c ported state by state
// (nfc_reader.h). It moves a tag's bytes and nothing else; every decision is
// the session's (nfc_reader_priv.h).
#include "nfc_reader_priv.h"
#include <string.h>

// ---- The vendor's names (SI512_App.h) -------------------------------------

enum {
    CommandReg = 0x01, ComIrqReg = 0x04, DivIrqReg = 0x05, ErrorReg = 0x06,
    Status2Reg = 0x08, FIFODataReg = 0x09, FIFOLevelReg = 0x0A, ControlReg = 0x0C,
    BitFramingReg = 0x0D, CollReg = 0x0E, ModeReg = 0x11, TxModeReg = 0x12,
    RxModeReg = 0x13, TxControlReg = 0x14, TxASKReg = 0x15, CRCResultRegH = 0x21,
    CRCResultRegL = 0x22, ModWidthReg = 0x24, RFCfgReg = 0x26, TModeReg = 0x2A,
    TPrescalerReg = 0x2B, TReloadRegH = 0x2C, TReloadRegL = 0x2D, VersionReg = 0x37,
};
enum { PCD_IDLE = 0x00, PCD_CALCCRC = 0x03, PCD_TRANSCEIVE = 0x0C, PCD_AUTHENT = 0x0E,
       PCD_RESETPHASE = 0x0F };
enum { PICC_REQALL = 0x52, PICC_ANTICOLL1 = 0x93, PICC_AUTHENT1A = 0x60,
       PICC_READ = 0x30, PICC_WRITE = 0xA0 };
#define RFCfgReg_Val 0x68

// ---- Timing ---------------------------------------------------------------

// The field (the reader's transmitter) is on only for a poll: on, this long
// for a tag to power up (ISO 14443's 5 ms), then WUPA. Between polls it is off,
// which is also every tag's power reset -- the next WUPA is a fresh detection.
// It used to stay on non-stop, and two bench modules died after days of that
// (2026-10-03, and the replacement by 2026-10-08; HANDOFF 3bb).
#define FIELD_SETTLE_MS      5
#define COM_TIMEOUT_MS      25   // the chip's own timer: TReload 1000 x 25 us
#define CRC_TIMEOUT_MS      10
#define RESET_TIMEOUT_MS    50

// ---- Register operations, counted --------------------------------------------
//
// Every handler below does AT MOST ONE of these per call; nfc_step() calls
// handlers while the budget lasts. A failed transfer ends the step, and the
// same operation is retried on the next one -- so a single glitch costs a
// step, not the tag, while three in a row mean the chip is gone.

static bool wr(nfc_reader_t *r, uint8_t reg, uint8_t v) {
    r->ops++;
    if (r->bus.wr(r->bus.ctx, reg, v)) { r->fails = 0; return true; }
    r->fails++;
    return false;
}

static int rd(nfc_reader_t *r, uint8_t reg) {
    r->ops++;
    int v = r->bus.rd(r->bus.ctx, reg);
    if (v >= 0) { r->fails = 0; return v; }
    r->fails++;
    return -1;
}

static void go(nfc_reader_t *r, st_t st) { nfc_go(r, st); }
static void call(nfc_reader_t *r, st_t sub) { nfc_call(r, sub); }
static void ret(nfc_reader_t *r) { nfc_ret(r); }

// ---- Scripts: straight runs of register writes ------------------------------
//
// The vendor's I_SI512_SetBitMask / ClearBitMask are a read and a write; here
// they are two script steps, the read kept in r->tmp, so they may straddle a
// step boundary. Only this code writes these registers, so the value cannot
// go stale in between.

enum { OP_W, OP_SET, OP_CLR };
typedef struct { uint8_t kind, reg, val; } op_t;

// One operation of `s`. Returns false if the step must end (failed transfer).
static bool script_op(nfc_reader_t *r, const op_t *s) {
    const op_t *o = &s[r->pc];
    if (o->kind == OP_W) {
        if (!wr(r, o->reg, o->val)) return false;
        r->pc++;
        return true;
    }
    if (r->tmp < 0) {
        int v = rd(r, o->reg);
        if (v < 0) return false;
        r->tmp = v;
        return true;
    }
    uint8_t v = o->kind == OP_SET ? (uint8_t)(r->tmp | o->val) : (uint8_t)(r->tmp & ~o->val);
    if (!wr(r, o->reg, v)) return false;
    r->tmp = -1;
    r->pc++;
    return true;
}
#define SCRIPT_LEN(s) ((int)(sizeof(s) / sizeof((s)[0])))

// PCD_SI512_TypeA_Init, line for line. Initiator FIRST: the Si512 is a
// PN512-style part that can also be a card, and until ControlReg's Initiator
// bit is set it is not a reader at all -- two bench tag watches saw nothing
// without it (2026-09-25). A soft reset clears it, so it is set after ours.
static const op_t INIT_OPS[] = {
    { OP_W,   ControlReg,    0x10 },           // Initiator
    { OP_CLR, Status2Reg,    0x08 },           // MFCrypto1On off
    { OP_W,   TxModeReg,     0x00 },           // 106 kbit, ISO 14443A framing
    { OP_W,   RxModeReg,     0x00 },
    { OP_W,   ModWidthReg,   0x26 },
    { OP_W,   RFCfgReg,      RFCfgReg_Val },   // RxGain 43 dB
    { OP_W,   TModeReg,      0x80 },           // TAuto: the timer starts at end of send,
    { OP_W,   TPrescalerReg, 0xA9 },           //   ticks at 40 kHz (25 us),
    { OP_W,   TReloadRegH,   0x03 },           //   and fires after 1000 ticks = 25 ms --
    { OP_W,   TReloadRegL,   0xE8 },           //   the chip's own "no tag answered"
    { OP_W,   TxASKReg,      0x40 },           // 100 % ASK
    // CRC preset 0x6363 (CRC_A). The Si512 resets ModeReg to 0x3B (preset
    // 0xFFFF, measured), so without this every CRC we compute is wrong.
    { OP_W,   ModeReg,       0x3D },
    { OP_W,   CommandReg,    PCD_IDLE },       // receiver analog part on
    // No PcdAntennaOn here: the field stays off until a poll (st_idle).
};

// PcdRequest's preamble. Its BitFramingReg = 0x07 travels as tx_bits into
// PcdComMF522, which writes it together with StartSend.
static const op_t REQ_OPS[] = {
    { OP_CLR, Status2Reg,   0x08 },
    { OP_SET, TxControlReg, 0x03 },
};
static const op_t ANTICOLL_PRE_OPS[]  = { { OP_CLR, Status2Reg, 0x08 }, { OP_CLR, CollReg, 0x80 } };
static const op_t ANTICOLL_POST_OPS[] = { { OP_SET, CollReg, 0x80 } };
static const op_t SELECT_PRE_OPS[]    = { { OP_CLR, Status2Reg, 0x08 } };
static const op_t FIELD_OFF_OPS[]     = { { OP_CLR, TxControlReg, 0x03 } };   // PcdAntennaOff
static const op_t FIELD_ON_OPS[]      = { { OP_SET, TxControlReg, 0x03 } };   // PcdAntennaOn

// ---- Subroutine calls ---------------------------------------------------------
//
// The caller sets its own phase to where it resumes BEFORE calling; the
// subroutine owns pc/i/tmp while it runs and hands back r->status.

static void call_com(nfc_reader_t *r, uint8_t cmd, int len, uint8_t tx_bits) {
    r->cmd = cmd;
    r->tx_len = len;
    r->tx_bits = tx_bits;
    call(r, ST_COM);
}

// CRC_A of tx[0..len) into tx[len], tx[len + 1].
static void call_crc(nfc_reader_t *r, int len) {
    r->crc_len = len;
    call(r, ST_CRC);
}

/*
 * PcdComMF522 as states. Differences from the vendor, each with the same
 * effect on the chip:
 *  - ComIrqReg is cleared by writing 0x7F (Set1 = 0 clears every marked
 *    bit) where the vendor reads it and writes back all but bit 7;
 *  - BitFramingReg is written whole: TxLastBits | StartSend, then TxLastBits,
 *    where the vendor sets and clears bit 7 by read-modify-write;
 *  - FIFOLevelReg FlushBuffer and ControlReg TStopNow are written direct.
 *    ControlReg is written 0x90, not 0x80: it keeps Initiator, which the
 *    vendor's read-modify-write keeps by reading it back;
 *  - ErrorReg is read once (the vendor reads it twice, once into a debug
 *    variable).
 * The wait is the vendor's: until TimerIRq or the command's own bits
 * (waitFor), read once per step, and a deadline stands in for its counter.
 */
static bool st_com(nfc_reader_t *r) {
    const uint8_t irqEn   = r->cmd == PCD_TRANSCEIVE ? 0x77 : 0x12;
    const uint8_t waitFor = r->cmd == PCD_TRANSCEIVE ? 0x30 : 0x10;
    int v;
    switch (r->pc) {
    case 0:
        if (!wr(r, ComIrqReg, 0x7F)) return false;
        r->pc++;
        return true;
    case 1:
        if (!wr(r, CommandReg, PCD_IDLE)) return false;
        r->pc++;
        return true;
    case 2:
        if (!wr(r, FIFOLevelReg, 0x80)) return false;
        r->pc++;
        return true;
    case 3:
        if (r->i < r->tx_len) {
            if (!wr(r, FIFODataReg, r->tx[r->i])) return false;
            r->i++;
            return true;
        }
        r->pc++;
        return true;
    case 4:
        if (!wr(r, CommandReg, r->cmd)) return false;
        r->t0 = r->now_ms();
        r->pc = r->cmd == PCD_TRANSCEIVE ? 5 : 6;
        return true;
    case 5:
        if (!wr(r, BitFramingReg, (uint8_t)(0x80 | r->tx_bits))) return false;   // StartSend
        r->t0 = r->now_ms();
        r->pc++;
        return true;
    case 6:
        v = rd(r, ComIrqReg);
        if (v < 0) return false;
        if ((v & 0x01) || (v & waitFor)) {
            r->irq = (uint8_t)v;
            r->pc++;
            return true;
        }
        if (r->now_ms() - r->t0 > COM_TIMEOUT_MS) {
            r->irq = 0;          // the vendor's counter ran out: MI_ERR
            r->pc++;
            return true;
        }
        return false;            // not yet: look again next step
    case 7:
        if (!wr(r, BitFramingReg, r->tx_bits)) return false;   // StartSend off
        if (!r->irq) { r->status = MI_ERR; r->pc = 12; return true; }
        r->pc++;
        return true;
    case 8:
        v = rd(r, ErrorReg);
        if (v < 0) return false;
        // BufferOvfl | CollErr | ParityErr | ProtocolErr (the vendor's mask).
        if (v & 0x1B) { r->status = MI_ERR; r->pc = 12; return true; }
        r->status = (r->irq & irqEn & 0x01) ? MI_NOTAGERR : MI_OK;
        r->pc = r->cmd == PCD_TRANSCEIVE ? 9 : 12;
        return true;
    case 9:
        v = rd(r, FIFOLevelReg);
        if (v < 0) return false;
        r->rx_n = v & 0x7F;
        r->pc++;
        return true;
    case 10: {
        v = rd(r, ControlReg);
        if (v < 0) return false;
        int lastBits = v & 0x07, n = r->rx_n;
        r->rx_bits = lastBits ? (n - 1) * 8 + lastBits : n * 8;
        if (n == 0) n = 1;
        if (n > NFC_FRAME_MAX) n = NFC_FRAME_MAX;
        r->rx_n = n;
        r->i = 0;
        r->pc++;
        return true;
    }
    case 11:
        if (r->i < r->rx_n) {
            v = rd(r, FIFODataReg);
            if (v < 0) return false;
            r->rx[r->i++] = (uint8_t)v;
            return true;
        }
        r->pc++;
        return true;
    case 12:
        if (!wr(r, ControlReg, 0x90)) return false;    // TStopNow, Initiator kept
        r->pc++;
        return true;
    default:
        if (!wr(r, CommandReg, PCD_IDLE)) return false;
        ret(r);
        return true;
    }
}

/*
 * CalulateCRC as states: the chip's CRC coprocessor, with ModeReg's 0x6363
 * preset -- CRC_A. Chosen over TxCRCEn/RxCRCEn because it is what the vendor
 * code does and what the bench has run; switching the chip to append and
 * check CRCs itself would change every received bit count the vendor's
 * checks are written against (unLen == 0x18, 0x90, 4).
 *
 * One deliberate difference: the vendor "clears" CRCIRq with
 * ClearBitMask(DivIrqReg, 0x04), a read and a write of (value & ~0x04) --
 * which, with Set2 = 0, clears every OTHER set bit and leaves CRCIRq set, so
 * its wait only works because the coprocessor beats the next bus read. We
 * write 0x04 (Set2 = 0: clear CRCIRq), which is what it meant.
 */
static bool st_crc(nfc_reader_t *r) {
    int v;
    switch (r->pc) {
    case 0:
        if (!wr(r, DivIrqReg, 0x04)) return false;
        r->pc++;
        return true;
    case 1:
        if (!wr(r, CommandReg, PCD_IDLE)) return false;
        r->pc++;
        return true;
    case 2:
        if (!wr(r, FIFOLevelReg, 0x80)) return false;
        r->pc++;
        return true;
    case 3:
        if (r->i < r->crc_len) {
            if (!wr(r, FIFODataReg, r->tx[r->i])) return false;
            r->i++;
            return true;
        }
        r->pc++;
        return true;
    case 4:
        if (!wr(r, CommandReg, PCD_CALCCRC)) return false;
        r->t0 = r->now_ms();
        r->pc++;
        return true;
    case 5:
        v = rd(r, DivIrqReg);
        if (v < 0) return false;
        if (v & 0x04) { r->pc++; return true; }
        if (r->now_ms() - r->t0 > CRC_TIMEOUT_MS) { r->status = MI_ERR; ret(r); return true; }
        return false;
    case 6:
        v = rd(r, CRCResultRegL);
        if (v < 0) return false;
        r->tx[r->crc_len] = (uint8_t)v;
        r->pc++;
        return true;
    default:
        v = rd(r, CRCResultRegH);
        if (v < 0) return false;
        r->tx[r->crc_len + 1] = (uint8_t)v;
        r->status = MI_OK;
        ret(r);
        return true;
    }
}

// ---- Protocol states ----------------------------------------------------------

// PcdReset, before the init: whatever state the chip came back in (a brown-
// out, a loose lead re-seated), it starts from its reset values. It may not
// answer while it resets; that is not a loss, so failed polls do not count
// until the 50 ms are up.
static bool st_reset(nfc_reader_t *r) {
    if (r->phase == 0) {
        if (!wr(r, CommandReg, PCD_RESETPHASE)) return false;
        r->t0 = r->now_ms();
        r->phase = 1;
        return true;
    }
    int v = rd(r, CommandReg);
    if (v >= 0 && !(v & 0x10)) { go(r, ST_INIT); return true; }   // PowerDown clear
    r->fails = 0;
    if (r->now_ms() - r->t0 > RESET_TIMEOUT_MS) nfc_lose_chip(r);
    return false;
}

static bool st_init(nfc_reader_t *r) {
    if (r->pc < SCRIPT_LEN(INIT_OPS)) return script_op(r, INIT_OPS);
    nfc_enter_idle(r, true);
    return true;
}

// The field is on only for a poll (nfc_reader.c: the field duty cycle).
static bool st_idle(nfc_reader_t *r) {
    switch (r->phase) {
    case 0:                                    // field off
        if (r->pc < SCRIPT_LEN(FIELD_OFF_OPS)) return script_op(r, FIELD_OFF_OPS);
        r->phase = 1;
        return true;
    case 1:                                    // wait for the poll
        if (!nfc_poll_due(r)) return false;
        r->phase = 2;
        r->pc = 0;
        r->tmp = -1;
        return true;
    case 2:                                    // field on
        if (r->pc < SCRIPT_LEN(FIELD_ON_OPS)) return script_op(r, FIELD_ON_OPS);
        r->t1 = r->now_ms();
        r->phase = 3;
        return true;
    default:                                   // let a tag power up
        if (r->now_ms() - r->t1 < FIELD_SETTLE_MS) return false;
        go(r, ST_REQ);
        return true;
    }
}

static bool st_req(nfc_reader_t *r) {
    if (r->phase == 0) {
        if (r->pc < SCRIPT_LEN(REQ_OPS)) return script_op(r, REQ_OPS);
        r->tx[0] = PICC_REQALL;          // WUPA: wakes IDLE and HALTed tags alike
        r->phase = 1;
        call_com(r, PCD_TRANSCEIVE, 1, 0x07);
        return true;
    }
    // An ATQA is 16 bits. Anything else (TimerIRq, a timeout, an error) is
    // "no tag", and says nothing.
    if (r->status == MI_OK && r->rx_bits == 16) {
        go(r, ST_ANTICOLL);
    } else {
        nfc_empty_poll(r);
    }
    return true;
}

static bool st_anticoll(nfc_reader_t *r) {
    switch (r->phase) {
    case 0:
        if (r->pc < SCRIPT_LEN(ANTICOLL_PRE_OPS)) return script_op(r, ANTICOLL_PRE_OPS);
        r->tx[0] = PICC_ANTICOLL1;
        r->tx[1] = 0x20;
        r->phase = 1;
        call_com(r, PCD_TRANSCEIVE, 2, 0x00);
        return true;
    case 1:
        // The vendor checks only the BCC; the length is checked too, so a
        // short answer cannot pass on the bytes of an earlier frame.
        if (r->status == MI_OK && r->rx_bits == 40 &&
            (uint8_t)(r->rx[0] ^ r->rx[1] ^ r->rx[2] ^ r->rx[3]) == r->rx[4]) {
            memcpy(r->uid, r->rx, 4);
            r->phase = 2;
        } else {
            r->phase = 3;
        }
        r->pc = 0;
        r->tmp = -1;
        return true;
    default:
        if (r->pc < SCRIPT_LEN(ANTICOLL_POST_OPS)) return script_op(r, ANTICOLL_POST_OPS);
        if (r->phase == 3) { nfc_enter_idle(r, false); return true; }   // collision or garbage
        break;
    }
    // The session decides whether this is a tap (nfc_arrival), before the
    // tag is even selected: a held tag is not read again.
    if (nfc_arrival(r)) go(r, ST_SELECT);
    return true;
}

static bool st_select(nfc_reader_t *r) {
    switch (r->phase) {
    case 0:
        r->tx[0] = PICC_ANTICOLL1;
        r->tx[1] = 0x70;
        r->tx[6] = 0;
        for (int k = 0; k < 4; k++) {
            r->tx[k + 2] = r->uid[k];
            r->tx[6] ^= r->uid[k];
        }
        r->phase = 1;
        call_crc(r, 7);
        return true;
    case 1:
        if (r->status != MI_OK) { nfc_moved(r); return true; }
        if (r->pc < SCRIPT_LEN(SELECT_PRE_OPS)) return script_op(r, SELECT_PRE_OPS);
        r->phase = 2;
        call_com(r, PCD_TRANSCEIVE, 9, 0x00);
        return true;
    default:
        if (r->status != MI_OK || r->rx_bits != 0x18) { nfc_moved(r); return true; }
        // SAK bit 3: MIFARE Classic (08 for the 1K). Without it -- an NTAG,
        // whose SAK 04 says "UID not complete", or anything else -- sector 1
        // does not exist, and the honest answer is "not ours", not "locked".
        if (!(r->rx[0] & 0x08)) { nfc_finish(r, NFC_EV_NOT_OURS, NULL); return true; }
        go(r, ST_AUTH);
        return true;
    }
}

static bool st_auth(nfc_reader_t *r) {
    static const uint8_t keyA[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
    if (r->phase == 0) {
        r->tx[0] = PICC_AUTHENT1A;
        r->tx[1] = FIRST_BLOCK;
        memcpy(r->tx + 2, keyA, 6);
        memcpy(r->tx + 8, r->uid, 4);
        r->phase = 1;
        call_com(r, PCD_AUTHENT, 12, 0x00);
        return true;
    }
    int v = rd(r, Status2Reg);
    if (v < 0) return false;
    // MFCrypto1On is the only proof: a wrong key ends in the timer, which
    // PcdComMF522 does not count as an error for MFAuthent. A tag that
    // leaves during these few ms fails the same way, and reads as "locked".
    bool ok = r->status == MI_OK && (v & 0x08);
    nfc_auth_done(r, ok);                    // not ok: "locked", reported
    if (ok) go(r, r->writing ? ST_WRITE : ST_READ);
    return true;
}

// PcdRead for ST_READ and ST_READBACK: the same exchange, a different buffer.
static bool st_read(nfc_reader_t *r) {
    switch (r->phase) {
    case 0:
        r->tx[0] = PICC_READ;
        r->tx[1] = (uint8_t)r->block;
        r->phase = 1;
        call_crc(r, 2);
        return true;
    case 1:
        if (r->status != MI_OK) { nfc_moved(r); return true; }
        r->phase = 2;
        call_com(r, PCD_TRANSCEIVE, 4, 0x00);
        return true;
    default:
        break;
    }
    // 16 data bytes + CRC_A = 0x90 bits.
    if (r->status != MI_OK || r->rx_bits != 0x90) { nfc_moved(r); return true; }
    if (nfc_block_in(r, r->rx, r->state == ST_READBACK)) r->phase = 0;
    return true;
}

// PcdWrite: the command and a 4-bit ACK (0x0A), then 16 bytes and an ACK.
static bool ack_ok(const nfc_reader_t *r) {
    return r->status == MI_OK && r->rx_bits == 4 && (r->rx[0] & 0x0F) == 0x0A;
}

static bool st_write(nfc_reader_t *r) {
    switch (r->phase) {
    case 0:
        r->tx[0] = PICC_WRITE;
        r->tx[1] = (uint8_t)r->block;
        r->phase = 1;
        call_crc(r, 2);
        return true;
    case 1:
        if (r->status != MI_OK) { nfc_moved(r); return true; }
        r->phase = 2;
        call_com(r, PCD_TRANSCEIVE, 4, 0x00);
        return true;
    case 2:
        if (!ack_ok(r)) { nfc_moved(r); return true; }
        memcpy(r->tx, nfc_block_out(r), 16);
        r->phase = 3;
        call_crc(r, 16);
        return true;
    case 3:
        if (r->status != MI_OK) { nfc_moved(r); return true; }
        r->phase = 4;
        call_com(r, PCD_TRANSCEIVE, 18, 0x00);
        return true;
    default:
        if (!ack_ok(r)) { nfc_moved(r); return true; }
        if (nfc_block_written(r)) { r->phase = 0; return true; }
        go(r, ST_READBACK);
        return true;
    }
}

// ---- The backend's entry points ---------------------------------------------------

int si512_probe(nfc_reader_t *r) {
    return rd(r, VersionReg);
}

bool si512_handle(nfc_reader_t *r) {
    switch ((st_t)r->state) {
    case ST_RESET:    return st_reset(r);
    case ST_INIT:     return st_init(r);
    case ST_IDLE:     return st_idle(r);
    case ST_REQ:      return st_req(r);
    case ST_ANTICOLL: return st_anticoll(r);
    case ST_SELECT:   return st_select(r);
    case ST_AUTH:     return st_auth(r);
    case ST_READ:
    case ST_READBACK: return st_read(r);
    case ST_WRITE:    return st_write(r);
    case ST_COM:      return st_com(r);
    case ST_CRC:      return st_crc(r);
    default:          return false;
    }
}
