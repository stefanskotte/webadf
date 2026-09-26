#include "si512_fake.h"
#include <string.h>

// Register addresses (vendor SI512_App.h). Deliberately NOT shared with
// nfc_reader.c: a typo there must disagree with the fake, not agree with it.
enum {
    CommandReg = 0x01, ComIrqReg = 0x04, DivIrqReg = 0x05, ErrorReg = 0x06,
    Status2Reg = 0x08, FIFODataReg = 0x09, FIFOLevelReg = 0x0A, ControlReg = 0x0C,
    BitFramingReg = 0x0D, ModeReg = 0x11, TxControlReg = 0x14,
    CRCResultRegH = 0x21, CRCResultRegL = 0x22, VersionReg = 0x37,
};

enum { TAG_IDLE, TAG_READY, TAG_ACTIVE, TAG_AUTHED };

#define REPLY_MS   1     // a tag's answer, as the IRQ poll sees it
#define TIMER_MS   25    // TPrescaler 0xA9, TReload 0x03E8: 1000 x 25 us
#define RESET_MS   2     // PowerDown stays set this long after SoftReset

static uint32_t now(const si512_fake_t *f) { return f->clock ? *f->clock : 0; }

static uint16_t crc_from(uint16_t crc, const uint8_t *b, int n) {
    for (int i = 0; i < n; i++) {
        crc ^= b[i];
        for (int k = 0; k < 8; k++)
            crc = (crc & 1) ? (uint16_t)((crc >> 1) ^ 0x8408) : (uint16_t)(crc >> 1);
    }
    return crc;
}

uint16_t si512_fake_crc_a(const uint8_t *b, int n) { return crc_from(0x6363, b, n); }

// Does a frame end in its own correct CRC_A (low byte first)? A tag stays
// silent on one that doesn't.
static bool crc_ok(const uint8_t *b, int n) {
    if (n < 3) return false;
    uint16_t c = si512_fake_crc_a(b, n - 2);
    return b[n - 2] == (uint8_t)c && b[n - 1] == (uint8_t)(c >> 8);
}

static void reset_values(si512_fake_t *f) {
    memset(f->reg, 0, sizeof f->reg);
    f->reg[CommandReg] = 0x20;       // RcvOff
    f->reg[0x02] = 0x80;             // ComIEnReg
    f->reg[ModeReg] = 0x3B;          // measured on the bench: not the RC522's 0x3F
    f->reg[TxControlReg] = 0x80;     // field off
    f->reg[0x26] = 0x48;             // RFCfgReg
    f->reg[VersionReg] = 0x82;       // measured on the bench
    // ControlReg 0x00: Initiator clear -- the chip is a card, not a reader.
    f->fifo_n = f->fifo_rd = 0;
    f->rx_last_bits = 0;
    f->irq_pending = 0;
    f->tag_state = TAG_IDLE;
    f->write_block = -1;
}

void si512_fake_init(si512_fake_t *f, const uint32_t *clock) {
    memset(f, 0, sizeof *f);
    f->tag_present = true;
    static const uint8_t uid[4] = { 0xDE, 0xAD, 0xBE, 0xEF };
    memcpy(f->uid, uid, 4);
    f->sak = 0x08;
    f->vanish_after_ops = -1;
    f->tag_leaves_after_ops = -1;
    f->clock = clock;
    f->initiator_at = f->txcontrol_at = f->first_read_at = -1;
    reset_values(f);
}

static bool field_on(const si512_fake_t *f) {
    return (f->reg[ControlReg] & 0x10) && (f->reg[TxControlReg] & 0x03) == 0x03;
}

static void fifo_push(si512_fake_t *f, const uint8_t *b, int n) {
    for (int i = 0; i < n && f->fifo_n < (int)sizeof f->fifo; i++) f->fifo[f->fifo_n++] = b[i];
}

// Take whatever the reader loaded into the FIFO as the outgoing frame.
static int take_frame(si512_fake_t *f, uint8_t *out) {
    int n = f->fifo_n - f->fifo_rd;
    memcpy(out, f->fifo + f->fifo_rd, (size_t)n);
    f->fifo_n = f->fifo_rd = 0;
    return n;
}

static void answer(si512_fake_t *f, const uint8_t *b, int n, uint8_t last_bits) {
    fifo_push(f, b, n);
    f->rx_last_bits = last_bits;
    f->irq_pending = 0x30;               // RxIRq | IdleIRq
    f->irq_at = now(f) + REPLY_MS;
}

// No answer: the tag drops back to IDLE (ISO 14443-3: any unexpected frame
// does), and the chip's timer fires as TAuto started it at end of send.
static void silence(si512_fake_t *f) {
    f->tag_state = TAG_IDLE;
    f->write_block = -1;
    f->irq_pending = 0x01;               // TimerIRq
    f->irq_at = now(f) + TIMER_MS;
}

static void answer_crc(si512_fake_t *f, const uint8_t *b, int n) {
    uint8_t out[20];
    memcpy(out, b, (size_t)n);
    uint16_t c = si512_fake_crc_a(b, n);
    out[n] = (uint8_t)c;
    out[n + 1] = (uint8_t)(c >> 8);
    answer(f, out, n + 2, 0);
}

static void transceive(si512_fake_t *f, uint8_t tx_bits) {
    uint8_t fr[64];
    int n = take_frame(f, fr);
    f->rx_last_bits = 0;
    if (n >= 1 && fr[0] == 0x30 && f->first_read_at < 0) f->first_read_at = f->ops;
    if (!f->tag_present) f->tag_state = TAG_IDLE;     // it lost power
    if (!f->tag_present || !field_on(f)) { silence(f); return; }

    // The second half of a WRITE: 16 bytes + CRC_A.
    if (f->write_block >= 0) {
        int b = f->write_block;
        f->write_block = -1;
        if (n != 18 || tx_bits != 0 || !crc_ok(fr, n)) { silence(f); return; }
        if (b >= 4 && b <= 6) memcpy(f->sector1 + (b - 4) * 16, fr, 16);
        uint8_t ack = 0x0A;
        answer(f, &ack, 1, 4);
        return;
    }
    // WUPA (7 bits) wakes an IDLE or HALTed tag.
    if (tx_bits == 7 && n == 1 && fr[0] == 0x52 && f->tag_state == TAG_IDLE) {
        static const uint8_t atqa[2] = { 0x04, 0x00 };
        f->tag_state = TAG_READY;
        answer(f, atqa, 2, 0);
        return;
    }
    if (tx_bits != 0) { silence(f); return; }
    // ANTICOLL cascade level 1: UID + BCC.
    if (n == 2 && fr[0] == 0x93 && fr[1] == 0x20 && f->tag_state == TAG_READY) {
        uint8_t u[5] = { f->uid[0], f->uid[1], f->uid[2], f->uid[3],
                         (uint8_t)(f->uid[0] ^ f->uid[1] ^ f->uid[2] ^ f->uid[3]) };
        answer(f, u, 5, 0);
        return;
    }
    // SELECT: 93 70 uid bcc CRC_A -> SAK + CRC_A.
    if (n == 9 && fr[0] == 0x93 && fr[1] == 0x70 && f->tag_state == TAG_READY &&
        memcmp(fr + 2, f->uid, 4) == 0 &&
        fr[6] == (uint8_t)(f->uid[0] ^ f->uid[1] ^ f->uid[2] ^ f->uid[3]) && crc_ok(fr, n)) {
        f->tag_state = TAG_ACTIVE;
        answer_crc(f, &f->sak, 1);
        return;
    }
    // READ and WRITE need an authenticated sector 1 (blocks 4..7).
    if (n == 4 && f->tag_state == TAG_AUTHED && crc_ok(fr, n) && fr[1] >= 4 && fr[1] <= 7) {
        if (fr[0] == 0x30) {
            uint8_t blk[16] = {0};
            if (fr[1] <= 6) memcpy(blk, f->sector1 + (fr[1] - 4) * 16, 16);
            if (f->flip_next_read) { blk[3] ^= 0x10; f->flip_next_read = false; }
            f->reads++;
            answer_crc(f, blk, 16);
            return;
        }
        if (fr[0] == 0xA0) {
            if (fr[1] == 7) f->trailer_writes++;
            f->write_block = fr[1];
            uint8_t ack = 0x0A;
            answer(f, &ack, 1, 4);
            return;
        }
    }
    silence(f);
}

// MFAuthent: 60 block key[6] uid[4]. Success sets MFCrypto1On and ends the
// command (IdleIRq). A wrong key gets no answer from the tag, and the command
// does not end on its own -- only the timer stops the wait.
static void authent(si512_fake_t *f) {
    uint8_t fr[64];
    int n = take_frame(f, fr);
    static const uint8_t key[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
    if (!f->tag_present) f->tag_state = TAG_IDLE;
    if (f->tag_present && field_on(f) && !f->locked && n == 12 && fr[0] == 0x60 &&
        fr[1] >= 4 && fr[1] <= 7 && memcmp(fr + 2, key, 6) == 0 &&
        memcmp(fr + 8, f->uid, 4) == 0 &&
        (f->tag_state == TAG_ACTIVE || f->tag_state == TAG_AUTHED)) {
        f->tag_state = TAG_AUTHED;
        f->reg[Status2Reg] |= 0x08;
        f->irq_pending = 0x10;
        f->irq_at = now(f) + REPLY_MS;
        return;
    }
    f->tag_state = TAG_IDLE;
    f->irq_pending = 0x01;
    f->irq_at = now(f) + TIMER_MS;
}

static void calc_crc(si512_fake_t *f) {
    uint8_t fr[64];
    int n = take_frame(f, fr);
    // ModeReg CRCPreset (bits 1..0) picks the start value. After a soft reset
    // it is 0xFFFF, which is NOT CRC_A: an init that skips ModeReg = 0x3D
    // makes every SELECT go unanswered.
    static const uint16_t preset[4] = { 0x0000, 0x6363, 0xA671, 0xFFFF };
    uint16_t c = crc_from(preset[f->reg[ModeReg] & 0x03], fr, n);
    f->reg[CRCResultRegL] = (uint8_t)c;
    f->reg[CRCResultRegH] = (uint8_t)(c >> 8);
    f->reg[DivIrqReg] |= 0x04;           // CRCIRq
}

// One transfer: counts it, and says whether it goes through.
static bool transfer(si512_fake_t *f) {
    int idx = f->ops++;
    if (f->tag_leaves_after_ops >= 0 && idx >= f->tag_leaves_after_ops) f->tag_present = false;
    return !(f->vanish_after_ops >= 0 && idx >= f->vanish_after_ops);
}

static bool fake_wr(void *ctx, uint8_t reg, uint8_t v) {
    si512_fake_t *f = ctx;
    int idx = f->ops;
    if (!transfer(f)) return false;
    if (reg >= 64) return true;
    switch (reg) {
    case CommandReg:
        switch (v & 0x0F) {
        case 0x0F:                                   // SoftReset
            reset_values(f);
            f->reset_until = now(f) + RESET_MS;
            break;
        case 0x00:                                   // Idle: cancels the command
            f->reg[CommandReg] = v & 0x30;
            f->irq_pending = 0;
            break;
        case 0x03: f->reg[CommandReg] = v; calc_crc(f); break;
        case 0x0E: f->reg[CommandReg] = v; authent(f); break;
        default:   f->reg[CommandReg] = v; break;   // Transceive waits for StartSend
        }
        break;
    case ComIrqReg:
    case DivIrqReg:
        // Set1/Set2: bit 7 says whether the marked bits are set or cleared.
        if (v & 0x80) f->reg[reg] |= v & 0x7F;
        else          f->reg[reg] &= (uint8_t)~(v & 0x7F);
        break;
    case FIFOLevelReg:
        if (v & 0x80) f->fifo_n = f->fifo_rd = 0;    // FlushBuffer
        break;
    case FIFODataReg: fifo_push(f, &v, 1); break;
    case BitFramingReg:
        f->reg[reg] = v & 0x7F;
        if ((v & 0x80) && (f->reg[CommandReg] & 0x0F) == 0x0C) transceive(f, v & 0x07);
        break;
    case ControlReg:
        if ((v & 0x10) && f->initiator_at < 0) f->initiator_at = idx;
        f->reg[reg] = v & 0x38;                      // TStopNow/TStartNow are strobes
        break;
    case TxControlReg:
        if (f->txcontrol_at < 0) f->txcontrol_at = idx;
        f->reg[reg] = v;
        if ((v & 0x03) != 0x03) f->tag_state = TAG_IDLE;   // field off: the tag loses power
        break;
    default: f->reg[reg] = v; break;
    }
    return true;
}

static int fake_rd(void *ctx, uint8_t reg) {
    si512_fake_t *f = ctx;
    if (reg == VersionReg) f->version_reads++;
    if (!transfer(f)) return -1;
    if (reg >= 64) return 0;
    switch (reg) {
    case CommandReg:
        return f->reg[CommandReg] | (now(f) < f->reset_until ? 0x10 : 0);   // PowerDown
    case ComIrqReg:
        if (f->irq_pending && now(f) >= f->irq_at) {
            f->reg[ComIrqReg] |= f->irq_pending;
            f->irq_pending = 0;
        }
        return f->reg[ComIrqReg];
    case ErrorReg: return 0;
    case FIFODataReg: return f->fifo_rd < f->fifo_n ? f->fifo[f->fifo_rd++] : 0;
    case FIFOLevelReg: return f->fifo_n - f->fifo_rd;
    case ControlReg: return (f->reg[ControlReg] & 0x38) | f->rx_last_bits;
    default: return f->reg[reg];
    }
}

nfc_bus_t si512_fake_bus(si512_fake_t *f) {
    nfc_bus_t b = { fake_wr, fake_rd, f };
    return b;
}
