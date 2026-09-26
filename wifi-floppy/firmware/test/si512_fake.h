#ifndef SI512_FAKE_H
#define SI512_FAKE_H
// A register model of the Si512 with one scripted MIFARE Classic 1K tag, for
// nfc_reader.c's host tests. Not a byte-accurate emulator: it models what the
// reader's correctness depends on, and those parts it models honestly --
//   - tags answer only with ControlReg Initiator (0x10) set and the field on
//     (TxControlReg & 0x03), the bench's first finding;
//   - a soft reset puts back the Si512's reset values, ModeReg 0x3B (CRC
//     preset 0xFFFF) and Initiator clear, so an init that skips a line fails;
//   - CalcCRC computes a real CRC_A from the preset ModeReg selects, and the
//     tag stays silent on a frame whose CRC_A is wrong -- exactly what a real
//     tag does, and what a wrong init would produce;
//   - ComIrqReg/DivIrqReg writes follow the Set1/Set2 rule (bit 7 set = set
//     the marked bits, clear = clear them);
//   - replies land in the FIFO at once, but the IRQ bits that say so appear
//     only `reply_ms` after the command started; no answer raises TimerIRq
//     25 ms after it (TReload 1000 x 25 us), as the chip's timer would.
#include <stdbool.h>
#include <stdint.h>
#include "../src/nfc_reader.h"

typedef struct {
    // --- the script ---
    bool    tag_present;
    uint8_t uid[4];
    uint8_t sak;               // 0x08: MIFARE Classic 1K
    uint8_t sector1[48];       // blocks 4, 5, 6
    bool    locked;            // key A is not FF..FF: MFAuthent fails
    int     vanish_after_ops;  // -1 never; after N ops every transfer fails
    int     tag_leaves_after_ops;  // -1 never; after N ops the tag is gone
    bool    flip_next_read;    // the next READ answers with one bit flipped
    const uint32_t *clock;     // the test's clock (ms); NULL = replies instant

    // --- what the reader did ---
    int ops;                   // every wr/rd call, failed ones included
    int version_reads;         // rd(VersionReg) calls
    int initiator_at;          // op index of the first ControlReg write with 0x10, -1
    int txcontrol_at;          // op index of the first TxControlReg write, -1
    int first_read_at;         // op index of the first READ (0x30) sent, -1
    int trailer_writes;        // WRITEs aimed at block 7 (must stay 0)
    int reads;                 // READ commands the tag answered

    // --- the chip (private) ---
    uint8_t reg[64];
    uint8_t fifo[64];
    int     fifo_n, fifo_rd;
    uint8_t rx_last_bits;
    uint8_t irq_pending;       // ComIrqReg bits that appear at irq_at
    uint32_t irq_at;
    uint32_t reset_until;
    int     tag_state;         // 0 idle, 1 ready, 2 active, 3 authenticated
    int     write_block;       // block of a WRITE awaiting its 16 bytes, -1
} si512_fake_t;

// A present chip with a present tag holding zeros, uid DE AD BE EF, SAK 08,
// nothing scheduled to fail.
void si512_fake_init(si512_fake_t *f, const uint32_t *clock);

nfc_bus_t si512_fake_bus(si512_fake_t *f);

// CRC_A (ISO 14443-3): poly 0x8408 reflected, init 0x6363, no xorout.
uint16_t si512_fake_crc_a(const uint8_t *b, int n);

#endif
