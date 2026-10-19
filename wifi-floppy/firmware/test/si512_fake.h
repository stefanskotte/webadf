#ifndef SI512_FAKE_H
#define SI512_FAKE_H
// A register model of the Si512 with one scripted tag -- a MIFARE Classic 1K,
// or an NFC Forum Type 2 tag (NTAG213/215/216, si512_fake_ntag) -- for
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
//   - a tag powers up from the field: it answers only once the field has
//     been on for SI512_FAKE_TAG_POWERUP_MS (ISO 14443's 5 ms), so a reader
//     that switches the field on and talks at once finds nothing;
//   - replies land in the FIFO at once, but the IRQ bits that say so appear
//     only `reply_ms` after the command started; no answer raises TimerIRq
//     25 ms after it (TReload 1000 x 25 us), as the chip's timer would;
//   - a Type 2 tag has a 7-byte (double-size) UID, so it takes two cascade
//     levels (ISO/IEC 14443-3, Type A anticollision): CL1's anticollision answers the cascade
//     tag 0x88 and UID0-2, its SELECT answers SAK 0x04 ("UID not complete"),
//     and only then do CL2's (SEL 0x95) answer UID3-6 and the final SAK 0x00.
//     It has no Crypto1: READ (0x30) answers four pages (16 bytes) and WRITE
//     (0xA2) one page with a 4-bit ACK 0xA, or a 4-bit NAK 0x0 (the NTAG213/215/
//     216 datasheet's READ, WRITE and ACK/NAK). Every WRITE it is sent is recorded, so
//     a test can prove pages 0-3 and the configuration pages are never aimed at.
#include <stdbool.h>
#include <stdint.h>
#include "../src/nfc_reader.h"

#define SI512_FAKE_TAG_POWERUP_MS 5

typedef struct {
    // --- the script ---
    bool    tag_present;
    uint8_t uid[7];
    int     uid_len;           // 4 (MIFARE Classic 1K) or 7 (a Type 2 tag)
    uint8_t sak;               // the final SAK: 0x08 MIFARE Classic 1K, 0x00 a Type 2 tag
    uint8_t sector1[48];       // blocks 4, 5, 6
    // A Type 2 tag (ntag_pages > 0; si512_fake_ntag): pages of 4 bytes.
    int     ntag_pages;        // 45 NTAG213, 135 NTAG215, 231 NTAG216; 0 = a Classic tag
    uint8_t mem[231 * 4];
    bool    write_protected;   // every WRITE is NAKed (a locked or password-protected tag)
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
    int page_writes;           // Type 2 WRITEs (0xA2) the tag accepted
    int low_page_writes;       // Type 2 WRITEs aimed at pages 0-3 (UID, lock, CC): must stay 0
    int cfg_page_writes;       // Type 2 WRITEs aimed at the dynamic lock / config pages: must stay 0
    int max_page_written;      // the highest page a WRITE was aimed at, -1
    int compat_writes;         // Type 2 COMPATIBILITY WRITEs (0xA0): never used, must stay 0
    uint32_t field_on_ms;      // total time the field has been on (closed intervals)
    uint32_t field_on_at;      // when the field last came on (valid while it is on)

    // --- the chip (private) ---
    uint8_t reg[64];
    uint8_t fifo[64];
    int     fifo_n, fifo_rd;
    uint8_t rx_last_bits;
    uint8_t irq_pending;       // ComIrqReg bits that appear at irq_at
    uint32_t irq_at;
    uint32_t reset_until;
    int     tag_state;         // 0 idle, 1 ready, 2 active, 3 authenticated, 4 ready at CL2
    int     write_block;       // block of a WRITE awaiting its 16 bytes, -1
} si512_fake_t;

// A present chip with a present tag holding zeros, uid DE AD BE EF, SAK 08,
// nothing scheduled to fail.
void si512_fake_init(si512_fake_t *f, const uint32_t *clock);

nfc_bus_t si512_fake_bus(si512_fake_t *f);

// Total field-on time so far, including the interval still open. Needs a clock.
uint32_t si512_fake_field_on_ms(const si512_fake_t *f);

// Makes the tag a factory-fresh NFC Forum Type 2 tag of `pages` pages
// (45 NTAG213, 135 NTAG215, 231 NTAG216) with the 7-byte `uid`: SAK 0x00, the
// UID and its check bytes in pages 0-2, the NTAG CC in page 3 and an empty
// NDEF TLV (03 00 FE) in page 4 -- what a bulk pack holds.
void si512_fake_ntag(si512_fake_t *f, int pages, const uint8_t uid[7]);

// The first dynamic-lock / configuration page of an NTAG21x of `pages` pages:
// 0x28 (213), 0x82 (215), 0xE2 (216) -- the last five pages.
int si512_fake_ntag_cfg_page(int pages);

// CRC_A (ISO 14443-3): poly 0x8408 reflected, init 0x6363, no xorout.
uint16_t si512_fake_crc_a(const uint8_t *b, int n);

#endif
