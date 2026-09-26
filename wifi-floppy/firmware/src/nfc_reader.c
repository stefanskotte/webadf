#include "nfc_reader.h"
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
enum { MI_OK, MI_NOTAGERR, MI_ERR };
#define RFCfgReg_Val 0x68

// ---- Timing ---------------------------------------------------------------

#define ABSENT_RECHECK_MS 5000   // spec §4.3
#define POLL_MS            250   // spec §4.1: tag detection about every 250 ms
// The same UID is a new arrival only after this long continuously unseen.
// 1 s was not enough: a fob lying untouched at the edge of the antenna's
// range dropped out for over a second three times in 4.5 minutes on the
// bench (2026-09-26), and each return was a fresh tap -- a write landed on
// it, and it re-mounted its disk after a web eject. A tap is deliberate: a
// hand lifts the tag and brings it back, which takes longer than this.
#define NFC_REARRIVAL_ABSENT_MS 3000
#define GAP_REPORT_MS            500   // a held tag's dropout longer than this is logged
#define FIELD_OFF_MS        10   // long enough for every tag to lose power and reset
#define COM_TIMEOUT_MS      25   // the chip's own timer: TReload 1000 x 25 us
#define CRC_TIMEOUT_MS      10
#define RESET_TIMEOUT_MS    50
#define LOSS_FAILS           3   // consecutive failed transfers = the chip is gone

// Sector 1 is blocks 4..7; 7 is the trailer and is never written.
#define FIRST_BLOCK 4
#define LAST_BLOCK  6

typedef enum {
    ST_ABSENT,     // one VersionReg read every 5 s
    ST_RESET,      // PcdReset: SoftReset, then wait for PowerDown to clear
    ST_INIT,       // PCD_SI512_TypeA_Init
    ST_IDLE,       // field on, waiting for the next poll
    ST_REQ,        // PcdRequest(WUPA)
    ST_ANTICOLL,   // PcdAnticoll(level 1) and the debounce decision
    ST_SELECT,     // PcdSelect
    ST_AUTH,       // PcdAuthState(key A, sector 1)
    ST_READ,       // PcdRead x 3
    ST_WRITE,      // PcdWrite x 3
    ST_READBACK,   // PcdRead x 3 after a write
    ST_REPORT,     // hand the finished event to the mailbox
    ST_COOLDOWN,   // field off 10 ms, on again
    ST_COM,        // subroutine: PcdComMF522
    ST_CRC,        // subroutine: CalulateCRC
} st_t;

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

static void go(nfc_reader_t *r, st_t st) {
    r->state = st;
    r->phase = r->pc = r->i = 0;
    r->tmp = -1;
}

static void emit(nfc_reader_t *r, const nfc_event_t *e) {
    r->ev = *e;
    r->has_ev = true;
}

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
    { OP_SET, TxControlReg,  0x03 },           // PcdAntennaOn
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

static void call(nfc_reader_t *r, st_t sub) {
    r->ret = r->state;
    r->state = sub;
    r->pc = r->i = 0;
    r->tmp = -1;
}

static void ret(nfc_reader_t *r) {
    r->state = r->ret;
    r->pc = r->i = 0;
    r->tmp = -1;
}

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

// ---- Building the event ---------------------------------------------------------

static void finish(nfc_reader_t *r, nfc_ev_kind_t kind, const char *why) {
    nfc_event_t *e = &r->built;
    memset(e, 0, sizeof *e);
    e->kind = kind;
    memcpy(e->uid, r->uid, 4);
    e->uid_len = 4;
    e->why = why;
    if (kind == NFC_EV_WRITE_DONE) {
        e->seq = r->write_seq;
        e->ok = why == NULL;
    }
    go(r, ST_REPORT);
}

// The tag stopped answering part-way, or the chip reported an error. For a
// write this is "moved" whatever block it reached: blocks written before it
// are covered by the payload CRC, so the tag reads back as bad data, never
// as a wrong disk.
static void moved(nfc_reader_t *r) {
    finish(r, r->writing ? NFC_EV_WRITE_DONE : NFC_EV_UNREADABLE, "moved");
}

// ---- Protocol states ----------------------------------------------------------

// The held tag has been unseen for the whole re-arrival window: it has left,
// and the same UID seen from now on is a new arrival. Decided here and only
// here, so a poll and the anticoll after it cannot disagree about it.
static void post_gap(nfc_reader_t *r, uint32_t now, bool new_arrival) {
    memcpy(r->gap.uid, r->last_uid, 4);
    r->gap.ms = now - r->last_detect;
    r->gap.new_arrival = new_arrival;
    r->has_gap = true;
}

static void expire_hold(nfc_reader_t *r, uint32_t now) {
    if (!r->held || now - r->last_seen < NFC_REARRIVAL_ABSENT_MS) return;
    r->held = false;
    post_gap(r, now, true);          // the gap's one line: it ended the tap
}

static bool st_absent(nfc_reader_t *r) {
    uint32_t now = r->now_ms();
    if (r->checked_once && now - r->t0 < ABSENT_RECHECK_MS) return false;
    r->checked_once = true;
    r->t0 = now;
    int v = rd(r, VersionReg);
    r->fails = 0;                    // silence is what ABSENT expects
    if (v < 0) return false;
    go(r, ST_RESET);
    nfc_event_t e = { .kind = NFC_EV_PRESENT };
    emit(r, &e);
    return false;
}

static void lose_chip(nfc_reader_t *r);

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
    if (r->now_ms() - r->t0 > RESET_TIMEOUT_MS) lose_chip(r);
    return false;
}

static void enter_idle(nfc_reader_t *r, bool poll_now) {
    go(r, ST_IDLE);
    r->t0 = r->now_ms() - (poll_now ? POLL_MS : 0);
}

static bool st_init(nfc_reader_t *r) {
    if (r->pc < SCRIPT_LEN(INIT_OPS)) return script_op(r, INIT_OPS);
    enter_idle(r, true);
    return true;
}

static bool st_idle(nfc_reader_t *r) {
    uint32_t now = r->now_ms();
    if (now - r->t0 < POLL_MS) return false;
    expire_hold(r, now);
    go(r, ST_REQ);
    return true;
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
        // Only an empty poll makes a gap a dropout: at one op per pass a
        // held tag can go a long while between polls without ever leaving.
        if (r->held) r->missed = true;
        enter_idle(r, false);
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
        if (r->phase == 3) { go(r, ST_COOLDOWN); return true; }   // collision or garbage
        break;
    }
    // A tag held on the reader is seen every ~quarter second, and only its
    // ARRIVAL is a tap: the held UID seen again is the same tap until it has
    // been unseen for the whole re-arrival window.
    uint32_t now = r->now_ms();
    expire_hold(r, now);
    if (r->held && memcmp(r->uid, r->last_uid, 4) == 0) {
        if (r->missed && now - r->last_detect > GAP_REPORT_MS) post_gap(r, now, false);
        r->last_seen = r->last_detect = now;
        r->missed = false;
        go(r, ST_COOLDOWN);
        return true;
    }
    // Read or write is decided here, once, from what was armed when the tag
    // arrived; a disarm or re-arm from now on does not change this tag's run.
    r->writing = r->armed;
    if (r->writing) {
        r->write_seq = r->arm_seq;
        memcpy(r->data, r->arm_payload, NFC_TAG_BYTES);
    }
    go(r, ST_SELECT);
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
        if (r->status != MI_OK) { moved(r); return true; }
        if (r->pc < SCRIPT_LEN(SELECT_PRE_OPS)) return script_op(r, SELECT_PRE_OPS);
        r->phase = 2;
        call_com(r, PCD_TRANSCEIVE, 9, 0x00);
        return true;
    default:
        if (r->status != MI_OK || r->rx_bits != 0x18) { moved(r); return true; }
        // SAK bit 3: MIFARE Classic (08 for the 1K). Without it -- an NTAG,
        // whose SAK 04 says "UID not complete", or anything else -- sector 1
        // does not exist, and the honest answer is "not ours", not "locked".
        if (!(r->rx[0] & 0x08)) { finish(r, NFC_EV_NOT_OURS, NULL); return true; }
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
    if (r->status != MI_OK || !(v & 0x08)) {
        finish(r, r->writing ? NFC_EV_WRITE_DONE : NFC_EV_UNREADABLE, "locked");
        return true;
    }
    go(r, r->writing ? ST_WRITE : ST_READ);
    r->block = FIRST_BLOCK;
    return true;
}

// PcdRead for ST_READ and ST_READBACK: the same exchange, a different buffer.
static bool st_read(nfc_reader_t *r) {
    uint8_t *dst = r->state == ST_READ ? r->data : r->back;
    switch (r->phase) {
    case 0:
        r->tx[0] = PICC_READ;
        r->tx[1] = (uint8_t)r->block;
        r->phase = 1;
        call_crc(r, 2);
        return true;
    case 1:
        if (r->status != MI_OK) { moved(r); return true; }
        r->phase = 2;
        call_com(r, PCD_TRANSCEIVE, 4, 0x00);
        return true;
    default:
        break;
    }
    // 16 data bytes + CRC_A = 0x90 bits.
    if (r->status != MI_OK || r->rx_bits != 0x90) { moved(r); return true; }
    memcpy(dst + (r->block - FIRST_BLOCK) * 16, r->rx, 16);
    if (r->block < LAST_BLOCK) {
        r->block++;
        r->phase = 0;
        return true;
    }
    if (r->state == ST_READBACK) {
        // Byte-identical, all 48, or it did not happen.
        finish(r, NFC_EV_WRITE_DONE, memcmp(r->back, r->data, NFC_TAG_BYTES) == 0 ? NULL : "verify");
        return true;
    }
    char id[NFC_DISK_ID_LEN + 1];
    nfc_tag_result_t res = nfc_tag_decode(r->data, id);
    if (res == NFC_TAG_OK) {
        finish(r, NFC_EV_TAG_READ, NULL);
        memcpy(r->built.disk_id, id, sizeof id);
    } else if (res == NFC_TAG_NOT_OURS) {
        finish(r, NFC_EV_NOT_OURS, NULL);
    } else {
        finish(r, NFC_EV_UNREADABLE, "bad data");
    }
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
        if (r->status != MI_OK) { moved(r); return true; }
        r->phase = 2;
        call_com(r, PCD_TRANSCEIVE, 4, 0x00);
        return true;
    case 2:
        if (!ack_ok(r)) { moved(r); return true; }
        memcpy(r->tx, r->data + (r->block - FIRST_BLOCK) * 16, 16);
        r->phase = 3;
        call_crc(r, 16);
        return true;
    case 3:
        if (r->status != MI_OK) { moved(r); return true; }
        r->phase = 4;
        call_com(r, PCD_TRANSCEIVE, 18, 0x00);
        return true;
    default:
        if (!ack_ok(r)) { moved(r); return true; }
        if (r->block < LAST_BLOCK) {
            r->block++;
            r->phase = 0;
            return true;
        }
        go(r, ST_READBACK);
        r->block = FIRST_BLOCK;
        return true;
    }
}

static bool st_report(nfc_reader_t *r) {
    // The tap is now reported: from here on, this UID held on the reader is
    // the same tap. Anchored at NOW, not at the anticoll that began it: at
    // one register op per pass (a mounted disk at 100 kHz) a read can take
    // over a second from anticoll to here, and an anchor that old would eat
    // into the re-arrival window before the tag had been polled even once.
    r->held = true;
    memcpy(r->last_uid, r->uid, 4);
    r->last_seen = r->last_detect = r->now_ms();
    r->missed = false;
    if (r->built.kind == NFC_EV_WRITE_DONE && r->armed && r->arm_seq == r->built.seq)
        r->armed = false;            // only the request that ran; a newer one stays
    r->writing = false;
    emit(r, &r->built);
    go(r, ST_COOLDOWN);
    return false;
}

// Field off long enough for every tag in it to lose power: the next WUPA is
// then a fresh detection, not a tag left in READY or ACTIVE by this round.
static bool st_cooldown(nfc_reader_t *r) {
    switch (r->phase) {
    case 0:
        if (r->pc < SCRIPT_LEN(FIELD_OFF_OPS)) return script_op(r, FIELD_OFF_OPS);
        r->t0 = r->now_ms();
        r->phase = 1;
        r->pc = 0;
        r->tmp = -1;
        return true;
    case 1:
        if (r->now_ms() - r->t0 < FIELD_OFF_MS) return false;
        r->phase = 2;
        return true;
    default:
        if (r->pc < SCRIPT_LEN(FIELD_ON_OPS)) return script_op(r, FIELD_ON_OPS);
        enter_idle(r, false);
        return true;
    }
}

// Three failed transfers in a row: the chip is gone. Whatever was half-built
// goes with it -- a tag read that did not finish reports nothing.
static void lose_chip(nfc_reader_t *r) {
    go(r, ST_ABSENT);
    r->t0 = r->now_ms();
    r->checked_once = true;
    r->fails = 0;
    r->writing = false;
    memset(&r->built, 0, sizeof r->built);
    nfc_event_t e = { .kind = NFC_EV_ABSENT };
    emit(r, &e);
}

static bool handle(nfc_reader_t *r) {
    switch ((st_t)r->state) {
    case ST_ABSENT:   return st_absent(r);
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
    case ST_REPORT:   return st_report(r);
    case ST_COOLDOWN: return st_cooldown(r);
    case ST_COM:      return st_com(r);
    case ST_CRC:      return st_crc(r);
    }
    return false;
}

// ---- API ----------------------------------------------------------------------

void nfc_init(nfc_reader_t *r, const nfc_bus_t *bus, uint32_t (*now_ms)(void)) {
    memset(r, 0, sizeof *r);
    r->bus = *bus;
    r->now_ms = now_ms;
    r->max_ops = NFC_MAX_OPS_PER_STEP;
    go(r, ST_ABSENT);
}

int nfc_step(nfc_reader_t *r) {
    r->ops = 0;
    // Back-pressure: while an event waits, hold still. Nothing is ever
    // overwritten, and nothing the caller has not seen is acted on.
    if (r->has_ev) return 0;
    if (r->arm_bad) {
        nfc_event_t e = { .kind = NFC_EV_WRITE_DONE, .seq = r->arm_seq, .ok = false,
                          .why = "bad data" };
        r->arm_bad = false;
        emit(r, &e);
        return 0;
    }
    while (r->ops < r->max_ops && !r->has_ev) {
        bool more = handle(r);
        if (r->fails >= LOSS_FAILS && r->state != ST_ABSENT) {
            lose_chip(r);
            break;
        }
        if (!more) break;
    }
    return r->ops;
}

bool nfc_take_event(nfc_reader_t *r, nfc_event_t *out) {
    if (!r->has_ev) return false;
    *out = r->ev;
    r->has_ev = false;
    return true;
}

bool nfc_take_gap(nfc_reader_t *r, nfc_gap_t *out) {
    if (!r->has_gap) return false;
    *out = r->gap;
    r->has_gap = false;
    return true;
}

void nfc_arm_write(nfc_reader_t *r, uint32_t seq, const char *disk_id) {
    // A tag held right now was on the reader before the write existed: the
    // arm counts as a sighting of it, so it is written only after a full
    // window away that began after the arm -- even if it was already part-
    // way through a dropout. A different tag is still written at once.
    uint32_t now = r->now_ms();
    expire_hold(r, now);
    if (r->held) r->last_seen = now;
    r->arm_seq = seq;
    r->armed = disk_id != NULL && nfc_tag_encode(disk_id, r->arm_payload);
    r->arm_bad = !r->armed;
}

void nfc_disarm(nfc_reader_t *r) {
    r->armed = false;
    r->arm_bad = false;
}

bool nfc_present(const nfc_reader_t *r) {
    return r->state != ST_ABSENT;
}

void nfc_set_max_ops(nfc_reader_t *r, int cap) {
    r->max_ops = cap < 1 ? 1 : cap > NFC_MAX_OPS_PER_STEP ? NFC_MAX_OPS_PER_STEP : cap;
}
