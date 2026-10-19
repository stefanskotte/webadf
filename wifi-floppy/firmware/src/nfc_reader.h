#ifndef NFC_READER_H
#define NFC_READER_H
// The tag reader as a step-wise state machine: an Si512 (HW-147C, MFRC522-
// style registers) at 0x28, or an NXP PN532 (frame protocol) at 0x24.
//
// WHY a state machine and not the vendor's blocking functions: the reader
// shares I2C1 with the OLED, and the bus belongs to core0 -- the real-time
// floppy core. core0 cannot sit in a 25 ms wait for a tag to answer, so
// every chip wait here is a state that re-reads one register (or one PN532
// status byte) per call, with a deadline taken from now_ms(). One nfc_step()
// does at most NFC_MAX_OPS_PER_STEP operations and returns; the caller fits
// it into the display pump's per-pass budget (spec §4.1).
//
// The files: nfc_reader.c is the SESSION -- chip detection, the poll clock,
// the hold windows, the Next card, arming, write + read-back verify, the
// event mailbox and the gaps -- and the one copy of all of it. Its two chip
// backends (nfc_reader_priv.h) only move tags' bytes:
//   - nfc_si512.c: the vendor's SI512_App.c (PCD_SI512_TypeA_Init,
//     PcdComMF522, PcdRequest, PcdAnticoll, PcdSelect, CalulateCRC,
//     PcdAuthState, PcdRead, PcdWrite, PcdReset) ported state by state; the
//     register names are the vendor's.
//   - nfc_pn532.c: NXP UM0701-02 (PN532 User Manual, Rev. 02) frames over
//     I2C -- SAMConfiguration, RFConfiguration, InListPassiveTarget and
//     InDataExchange (MIFARE auth / read / write, Type 2 read / write).
// Two kinds of tag are read and written (nfc_reader_priv.h nfc_kind_t): a
// MIFARE Classic 1K (4-byte UID, SAK bit 3; sector 1, key A) and an NFC Forum
// Type 2 tag -- NTAG213/215/216 (7-byte UID, SAK 0x00; pages 4-15, no auth).
// Any other kind is NFC_EV_NOT_SUPPORTED.
// Which one runs is decided at every presence check: the Si512 first, then
// the PN532 (nfc_attach_pn532), else absent.
//
// RULE: these files may include only C standard headers plus nfc_tag.h.
// The bus is reached only through nfc_bus_t / nfc_frame_bus_t, so the whole
// reader runs on the host against test/si512_fake.c and test/pn532_fake.c.
#include <stdint.h>
#include <stdbool.h>
#include "nfc_tag.h"

// One register operation each. A read is one operation (the address write
// and the repeated-start read are one transfer as far as the budget goes).
typedef struct {
    bool (*wr)(void *ctx, uint8_t reg, uint8_t v);   // false = transfer failed
    int  (*rd)(void *ctx, uint8_t reg);               // <0 = transfer failed
    void *ctx;
} nfc_bus_t;

// The PN532's bus: whole I2C transfers, not registers (UM0701-02 §6.2.4).
// A write is one complete frame; a read is the status byte and whatever
// follows it, in ONE transfer (a STOP before the frame's end loses the
// rest, §6.2.4). Each costs a whole nfc_step (see NFC_MAX_OPS_PER_STEP).
typedef struct {
    bool (*wr)(void *ctx, const uint8_t *buf, int n);   // false = transfer failed (NACK, timeout)
    bool (*rd)(void *ctx, uint8_t *buf, int n);         // false = transfer failed
    // Sets the bus clock (Hz); NULL = leave it. Asked once a PN532 has
    // answered: see nfc_pn532.c, "the bus clock".
    void (*set_hz)(void *ctx, uint32_t hz);
    void *ctx;
} nfc_frame_bus_t;

typedef enum { NFC_CHIP_NONE, NFC_CHIP_SI512, NFC_CHIP_PN532 } nfc_chip_t;

// NOT_OURS: a kind of tag we read (Classic 1K, NTAG21x) holding no WFDK
// payload -- "not a disk tag". NOT_SUPPORTED (1.18.1): any other kind -- an
// ISO-DEP card, a 7-byte Classic, a DESFire -- never read or written. Added
// last, so the older kinds keep their values.
typedef enum { NFC_EV_NONE, NFC_EV_TAG_READ, NFC_EV_NOT_OURS, NFC_EV_UNREADABLE,
               NFC_EV_WRITE_DONE, NFC_EV_PRESENT, NFC_EV_ABSENT,
               NFC_EV_TAG_NEXT, NFC_EV_NOT_SUPPORTED } nfc_ev_kind_t;

// The longest UID handled: a double-size (7-byte) UID -- an NTAG21x.
#define NFC_UID_MAX 7

typedef struct {
    nfc_ev_kind_t kind;
    uint8_t  uid[NFC_UID_MAX];
    uint8_t  uid_len;                // 4 or 7; 0 for PRESENT / ABSENT
    char     disk_id[37];            // TAG_READ
    const char *why;                 // UNREADABLE / WRITE_DONE failure: "locked", "bad data",
                                     // "moved", "verify" (write only); NULL otherwise
    uint32_t seq; bool ok;           // WRITE_DONE
    // UNREADABLE / WRITE_DONE failure on a PN532 (2026-10-19): the status byte the chip answered (UM0701-02
    // §7.1, bits 0-5 the error code) and the InDataExchange command byte that drew it (0x60 auth, 0x30 READ,
    // 0xA0 / 0xA2 WRITE). pn_cmd 0 = no detail (a good event, the Si512, or no status at all).
    uint8_t  pn_status, pn_cmd;
} nfc_event_t;

// A detection gap on a held tag: `ms` unseen, reported when it is seen again
// (new_arrival false: still the same tap) or as the gap crosses the
// re-arrival window -- 3 s, or 1 s for a Next-disk card -- (new_arrival
// true). Measurement only -- it decides nothing. This file may not log (the RULE above), so the caller does.
typedef struct {
    uint8_t  uid[NFC_UID_MAX];
    uint8_t  uid_len;                // 4 or 7
    uint32_t ms;
    bool     new_arrival;
} nfc_gap_t;

// The cap is in Si512 register operations (~3 bytes on the bus each). A
// PN532 step is ONE of: a status-byte read (1 op, 2 bytes on the bus), or one
// whole frame transfer, which uses up the rest of the step and is the only
// transfer in it -- at most 28 bytes written (InDataExchange WRITE) or 27 read
// (a READ's answer): ~0.7 ms at 400 kHz, ~2.6 ms at 100 kHz.
#define NFC_MAX_OPS_PER_STEP 4

// The PN532 frame buffer: the largest frame either way here is 28 bytes; a
// longer answer (an ISO 14443-4 card's ATS, a 10-byte UID) is re-read whole
// up to this size and refused past it, never written past it.
#define NFC_PN532_BUF 64

// The vendor's MAXRLEN: the largest frame either way (16 data bytes + CRC_A).
#define NFC_FRAME_MAX 18

// Defined here so callers can allocate it statically; the fields are private
// to nfc_reader.c by convention.
typedef struct nfc_reader {
    nfc_bus_t bus;
    uint32_t (*now_ms)(void);
    nfc_frame_bus_t fbus;  // the PN532's, if attached (has_fbus)
    bool has_fbus;
    int  chip;             // nfc_chip_t: the chip this session talks to

    int state;           // the protocol state (nfc_reader.c's st_t)
    int phase;           // where inside that state
    int pc;              // where inside the running script / subroutine
    int i;               // byte counter for FIFO loads and unloads
    int tmp;             // the read half of a read-modify-write
    int ops;             // register operations used in this step
    int max_ops;         // this step's cap: 1..NFC_MAX_OPS_PER_STEP (nfc_set_max_ops)
    int fails;           // consecutive failed transfers
    uint32_t t0;         // when the current wait began
    uint32_t t1;         // when the field came on for this poll (st_idle)
    bool checked_once;   // ABSENT has made its first presence check

    // The PcdComMF522 / CalulateCRC subroutine: its arguments and results.
    int      ret;        // the state to resume when it finishes
    uint8_t  cmd;        // PCD_TRANSCEIVE or PCD_AUTHENT
    uint8_t  tx[NFC_FRAME_MAX + 2];
    int      tx_len;
    uint8_t  tx_bits;    // BitFramingReg TxLastBits (7 for WUPA, else 0)
    int      crc_len;    // CalulateCRC input length; the CRC lands at tx[crc_len]
    uint8_t  irq;        // ComIrqReg as the wait ended
    int      status;     // MI_OK / MI_NOTAGERR / MI_ERR
    uint8_t  rx[NFC_FRAME_MAX];
    int      rx_n;
    int      rx_bits;

    // The tag being handled. Discarded whole if the chip is lost.
    uint8_t  uid[NFC_UID_MAX];
    uint8_t  uid_len;    // 4 (single-size) or 7 (double-size)
    uint8_t  kind;       // nfc_reader_priv.h nfc_kind_t, decided at selection
    uint8_t  sub;        // a Type 2 write: the page (0..3) inside the 16-byte block
    int      block;
    bool     writing;    // this arrival runs WRITE, decided when it arrived
    uint32_t write_seq;
    uint8_t  data[NFC_TAG_BYTES];      // read, or the payload being written
    uint8_t  back[NFC_TAG_BYTES];      // the read-back after a write
    nfc_event_t built;

    // The held tag: the last one reported, until it has been unseen for the
    // re-arrival window (3 s; 1 s for a Next-disk card while nothing is armed
    // -- nfc_reader.c hold_window). last_seen is the anchor that window runs
    // from: the report, every later sighting, an arm while it is held, and the
    // chip's return after an outage (which says nothing about the tag).
    bool     held;
    bool     held_next;    // the held tag was reported as NFC_EV_TAG_NEXT
    uint8_t  last_uid[NFC_UID_MAX];
    uint8_t  last_uid_len;
    uint32_t last_seen;
    uint32_t last_detect;  // the last time it truly answered (arming is no sighting)
    bool     missed;       // a poll since then found no tag at all

    // The newest dropout, for the log; a later one replaces an untaken one.
    bool      has_gap;
    nfc_gap_t gap;

    // The armed write.
    bool     armed;
    bool     arm_bad;    // armed with an id that has no disk-id shape
    uint32_t arm_seq;
    uint8_t  arm_payload[NFC_TAG_BYTES];

    // The one-slot mailbox.
    bool        has_ev;
    nfc_event_t ev;

    // The PN532 backend (nfc_pn532.c).
    bool     pn_probe_due;   // the Si512 just did not answer: try the PN532 next step
    bool     probing;        // the PN532 is being tried, not yet found (not "present")
    uint32_t t_probe;        // when that presence check began
    uint32_t pn_t;           // when the current command's wait began
    uint32_t t_si512;        // while on a PN532: when the Si512 was last asked
    uint8_t  pn_cmd;         // the command in flight (its answer is pn_cmd + 1)
    int      pn_rd_len;      // bytes to read for its answer, status byte included
    uint32_t pn_wait_ms;     // how long its answer may take
    int      pn_bad;         // consecutive failed commands: LOSS_FAILS = the chip is gone
    int      pn_nacks;       // NACKs sent for the current answer
    bool     pn_field;       // the PN532's field may be on
    bool     pn_target;      // InListPassiveTarget found a target that InRelease has not released yet
    uint8_t  pn_err_status;  // the failure detail for the event being built (nfc_event_t pn_status/pn_cmd);
    uint8_t  pn_err_cmd;     // nfc_finish copies both into it and clears them
    uint8_t  sak;            // the tag's SEL_RES, from InListPassiveTarget
    int      pn_at;          // where the answer's payload starts in pn_buf
    uint8_t  pn_buf[NFC_PN532_BUF];
} nfc_reader_t;

// Starts in ABSENT; the first nfc_step() makes the boot-time presence check.
void nfc_init(nfc_reader_t *r, const nfc_bus_t *bus, uint32_t (*now_ms)(void));

// Gives the reader a PN532 to look for when the Si512 does not answer.
// Without it (the host tests of the Si512 alone) only the Si512 is tried.
void nfc_attach_pn532(nfc_reader_t *r, const nfc_frame_bus_t *fbus);

// One slice of work. Returns the register operations used, never more than
// NFC_MAX_OPS_PER_STEP. At most one event is produced per step, and while an
// event waits in the slot the reader does nothing at all (returns 0): no
// event is ever overwritten, so the caller need only drain the slot between
// steps.
int  nfc_step(nfc_reader_t *r);

// Caps each later nfc_step() at `cap` register operations, clamped to
// 1..NFC_MAX_OPS_PER_STEP (nfc_init sets the full budget). The caller lowers
// it where a pass must stay short -- on the board, while a disk is mounted
// and the bus runs at 100 kHz (no panel), where 4 operations are ~2 ms.
void nfc_set_max_ops(nfc_reader_t *r, int cap);

// One-slot mailbox; false = none.
bool nfc_take_event(nfc_reader_t *r, nfc_event_t *out);

// The dropout measurement (nfc_gap_t); false = none. At most one per gap:
// a held tag's gap over 500 ms that a poll found empty. Slow polls -- one
// register op per pass while a disk is mounted -- are not gaps.
bool nfc_take_gap(nfc_reader_t *r, nfc_gap_t *out);

// While armed, the next tag ARRIVAL is written with `disk_id` instead of
// read, whatever it holds, and reports WRITE_DONE with `seq`. An arrival is
// a different UID, or the same UID after 3 s continuously unseen (as for a
// disk tag's read; a held Next-disk card's 1 s does not apply while armed).
// A write never goes to a tag that was already on the reader when it was
// armed: if a tag is held at this call, that UID is written only after
// it has been unseen for 3 s counted from no earlier than this call, and has
// arrived again; a different tag arriving is written at once. Re-arming
// replaces the request. An id without the disk-id shape is
// refused with WRITE_DONE{seq, ok=false, why="bad data"} on the next step.
void nfc_arm_write(nfc_reader_t *r, uint32_t seq, const char *disk_id);
// Identical to nfc_arm_write, except the payload is the WFDK v2 "next" card
// (nfc_tag_encode_next) rather than a disk id -- always well-formed, so this
// never refuses with "bad data".
void nfc_arm_write_next(nfc_reader_t *r, uint32_t seq);
// Withdraws the armed write. A write already under way finishes and reports.
void nfc_disarm(nfc_reader_t *r);

// The chip answers (any state but ABSENT, and not while a PN532 is only
// being tried).
bool nfc_present(const nfc_reader_t *r);

// Which chip is present: NFC_CHIP_NONE while absent.
nfc_chip_t nfc_chip(const nfc_reader_t *r);

#endif
