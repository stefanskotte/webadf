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
enum { PICC_REQALL = 0x52, PICC_ANTICOLL1 = 0x93, PICC_ANTICOLL2 = 0x95, PICC_AUTHENT1A = 0x60,
       PICC_READ = 0x30, PICC_WRITE = 0xA0 };
// Not the vendor's: the Type 2 (NTAG21x / Ultralight) one-page WRITE.
enum { PICC_T2_WRITE = 0xA2 };
// ISO/IEC 14443-3 Type A: the cascade tag that opens CL1 of a double-size
// UID, and the SAK bit that says "UID not complete" (the vendor tests
// SAK & 0x04 the same way in its Request-Anticoll-Select loop).
#define CASCADE_TAG   0x88
#define SAK_CASCADE   0x04
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
            nfc_uid_set(r, r->rx, 4);    // CL1: the whole UID, or CT + UID0-2
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
    // CL1 began with the cascade tag: a double-size UID (an NTAG), whose rest
    // is at cascade level 2 (st_cascade). A single-size UID is complete.
    if (r->uid[0] == CASCADE_TAG) { go(r, ST_CASCADE); return true; }
    r->uid_len = 4;
    // The session decides whether this is a tap (nfc_arrival), before the
    // tag is even selected: a held tag is not read again.
    if (nfc_arrival(r)) go(r, ST_SELECT);
    return true;
}

// The SELECT frame for the UID part at this cascade level, its CRC_A to come:
// sel 70 part[4] BCC (the vendor's PcdSelect1 / PcdSelect2).
static void select_frame(nfc_reader_t *r, uint8_t sel, const uint8_t part[4]) {
    r->tx[0] = sel;
    r->tx[1] = 0x70;
    r->tx[6] = 0;
    for (int k = 0; k < 4; k++) {
        r->tx[k + 2] = part[k];
        r->tx[6] ^= part[k];
    }
}

/*
 * A double-size UID, as the vendor's Request-Anticoll-Select loop does it
 * (SI512_App.c: PcdAnticoll(UID, PICC_ANTICOLL1), PcdSelect1, SAK & 0x04,
 * PcdAnticoll(UID + 4, PICC_ANTICOLL2)) and as ISO/IEC 14443-3 describes it:
 * CL1 answered CT 88 + UID0-2; SELECT at CL1 answers SAK 0x04 (UID not
 * complete); ANTICOLL at CL2 (SEL 0x95) answers UID3-6 + BCC. Only then is the
 * UID whole, and only then can the session tell this tag from another
 * (nfc_arrival): two NTAGs share CL1 when their first three bytes match. The
 * last SELECT, at CL2, is st_select's. Anything off the script here -- no
 * cascade bit, a bad BCC, no answer -- is a collision or a tag at the edge of
 * the field: back to idle, nothing reported (as a bad CL1 answer).
 */
static bool st_cascade(nfc_reader_t *r) {
    switch (r->phase) {
    case 0:
        select_frame(r, PICC_ANTICOLL1, r->uid);
        r->phase = 1;
        call_crc(r, 7);
        return true;
    case 1:
        if (r->status != MI_OK) { nfc_enter_idle(r, false); return true; }
        if (r->pc < SCRIPT_LEN(SELECT_PRE_OPS)) return script_op(r, SELECT_PRE_OPS);
        r->phase = 2;
        call_com(r, PCD_TRANSCEIVE, 9, 0x00);
        return true;
    case 2:
        if (r->status != MI_OK || r->rx_bits != 0x18 || !(r->rx[0] & SAK_CASCADE)) {
            nfc_enter_idle(r, false);
            return true;
        }
        r->phase = 3;
        r->pc = 0;
        r->tmp = -1;
        return true;
    case 3:
        if (r->pc < SCRIPT_LEN(ANTICOLL_PRE_OPS)) return script_op(r, ANTICOLL_PRE_OPS);
        r->tx[0] = PICC_ANTICOLL2;
        r->tx[1] = 0x20;
        r->phase = 4;
        call_com(r, PCD_TRANSCEIVE, 2, 0x00);
        return true;
    case 4:
        if (r->status == MI_OK && r->rx_bits == 40 &&
            (uint8_t)(r->rx[0] ^ r->rx[1] ^ r->rx[2] ^ r->rx[3]) == r->rx[4]) {
            uint8_t u[7] = { r->uid[1], r->uid[2], r->uid[3], r->rx[0], r->rx[1], r->rx[2], r->rx[3] };
            nfc_uid_set(r, u, 7);
            r->phase = 5;
        } else {
            r->phase = 6;
        }
        r->pc = 0;
        r->tmp = -1;
        return true;
    default:
        if (r->pc < SCRIPT_LEN(ANTICOLL_POST_OPS)) return script_op(r, ANTICOLL_POST_OPS);
        if (r->phase == 6) { nfc_enter_idle(r, false); return true; }
        break;
    }
    if (nfc_arrival(r)) go(r, ST_SELECT);
    return true;
}

// The last SELECT: CL1 for a single-size UID, CL2 (UID3-6) for a double-size
// one. Its SAK says what the tag is (nfc_tag_selected).
static bool st_select(nfc_reader_t *r) {
    switch (r->phase) {
    case 0:
        if (r->uid_len == 7) select_frame(r, PICC_ANTICOLL2, r->uid + 3);
        else                 select_frame(r, PICC_ANTICOLL1, r->uid);
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
        // SAK 08 with a 4-byte UID: MIFARE Classic, on to key A. SAK 00 with
        // a 7-byte UID: a Type 2 tag (an NTAG), no auth. Anything else --
        // an ISO-DEP card, a 7-byte Classic, a DESFire -- is "not supported",
        // and reported as such, not as "not a disk tag" (nfc_tag_selected).
        if (!nfc_tag_selected(r, r->rx[0])) return true;
        if (r->kind == NFC_KIND_CLASSIC) go(r, ST_AUTH);
        else go(r, r->writing ? ST_WRITE : ST_READ);
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
        r->tx[0] = PICC_READ;            // the same frame on a Type 2 tag: four pages
        r->tx[1] = nfc_read_addr(r);
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

// A Type 2 tag's WRITE: A2 page d0..d3 + CRC_A, one page, answered by the
// same 4-bit ACK (0xA) as a Classic WRITE's halves -- handled the same way,
// by ack_ok -- or by a 4-bit NAK (0x0 / 0x1 / 0x4 / 0x5): the tag is there
// and refuses the page, which is "locked", not "moved". Never the 16-byte
// COMPATIBILITY WRITE (0xA0), and never a page outside 4-15 (nfc_t2_page).
static bool st_write_t2(nfc_reader_t *r) {
    switch (r->phase) {
    case 0: {
        int pg = nfc_t2_page(r);
        if (pg < 0) { nfc_moved(r); return true; }   // cannot happen; nothing is sent
        r->tx[0] = PICC_T2_WRITE;
        r->tx[1] = (uint8_t)pg;
        memcpy(r->tx + 2, nfc_t2_page_out(r), 4);
        r->phase = 1;
        call_crc(r, 6);
        return true;
    }
    case 1:
        if (r->status != MI_OK) { nfc_moved(r); return true; }
        r->phase = 2;
        call_com(r, PCD_TRANSCEIVE, 8, 0x00);
        return true;
    default:
        if (ack_ok(r)) {
            if (nfc_t2_page_written(r)) { r->phase = 0; return true; }
            go(r, ST_READBACK);
            return true;
        }
        if (r->status == MI_OK && r->rx_bits == 4) { nfc_write_refused(r); return true; }   // a NAK
        nfc_moved(r);
        return true;
    }
}

static bool st_write(nfc_reader_t *r) {
    if (r->kind == NFC_KIND_T2) return st_write_t2(r);
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
    case ST_CASCADE:  return st_cascade(r);
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
