#ifndef NFC_READER_H
#define NFC_READER_H
// The Si512 (HW-147C) tag reader as a step-wise state machine.
//
// WHY a state machine and not the vendor's blocking functions: the reader
// shares I2C1 with the OLED, and the bus belongs to core0 -- the real-time
// floppy core. core0 cannot sit in a 25 ms wait for a tag to answer, so
// every chip wait here is a state that re-reads one register per call, with
// a deadline taken from now_ms(). One nfc_step() does at most
// NFC_MAX_OPS_PER_STEP register operations and returns; the caller fits it
// into the display pump's per-pass budget (spec §4.1).
//
// The protocol is the vendor's SI512_App.c (PCD_SI512_TypeA_Init,
// PcdComMF522, PcdRequest, PcdAnticoll, PcdSelect, CalulateCRC,
// PcdAuthState, PcdRead, PcdWrite, PcdReset) ported state by state; the
// register names are the vendor's.
//
// RULE: this file and nfc_reader.c may include only C standard headers plus
// nfc_tag.h. The bus is reached only through nfc_bus_t, so the whole reader
// runs on the host against test/si512_fake.c.
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

typedef enum { NFC_EV_NONE, NFC_EV_TAG_READ, NFC_EV_NOT_OURS, NFC_EV_UNREADABLE,
               NFC_EV_WRITE_DONE, NFC_EV_PRESENT, NFC_EV_ABSENT } nfc_ev_kind_t;

typedef struct {
    nfc_ev_kind_t kind;
    uint8_t  uid[4]; int uid_len;    // 0 for PRESENT / ABSENT
    char     disk_id[37];            // TAG_READ
    const char *why;                 // UNREADABLE / WRITE_DONE failure: "locked", "bad data",
                                     // "moved", "verify" (write only); NULL otherwise
    uint32_t seq; bool ok;           // WRITE_DONE
} nfc_event_t;

#define NFC_MAX_OPS_PER_STEP 4

// The vendor's MAXRLEN: the largest frame either way (16 data bytes + CRC_A).
#define NFC_FRAME_MAX 18

// Defined here so callers can allocate it statically; the fields are private
// to nfc_reader.c by convention.
typedef struct nfc_reader {
    nfc_bus_t bus;
    uint32_t (*now_ms)(void);

    int state;           // the protocol state (nfc_reader.c's st_t)
    int phase;           // where inside that state
    int pc;              // where inside the running script / subroutine
    int i;               // byte counter for FIFO loads and unloads
    int tmp;             // the read half of a read-modify-write
    int ops;             // register operations used in this step
    int fails;           // consecutive failed transfers
    uint32_t t0;         // when the current wait began
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
    uint8_t  uid[4];
    uint32_t seen_at;
    int      block;
    bool     writing;    // this arrival runs WRITE, decided when it arrived
    uint32_t write_seq;
    uint8_t  data[NFC_TAG_BYTES];      // read, or the payload being written
    uint8_t  back[NFC_TAG_BYTES];      // the read-back after a write
    nfc_event_t built;

    // Debounce.
    bool     have_last;
    uint8_t  last_uid[4];
    uint32_t last_seen;

    // The armed write.
    bool     armed;
    bool     arm_bad;    // armed with an id that has no disk-id shape
    uint32_t arm_seq;
    uint8_t  arm_payload[NFC_TAG_BYTES];

    // The one-slot mailbox.
    bool        has_ev;
    nfc_event_t ev;
} nfc_reader_t;

// Starts in ABSENT; the first nfc_step() makes the boot-time presence check.
void nfc_init(nfc_reader_t *r, const nfc_bus_t *bus, uint32_t (*now_ms)(void));

// One slice of work. Returns the register operations used, never more than
// NFC_MAX_OPS_PER_STEP. At most one event is produced per step, and while an
// event waits in the slot the reader does nothing at all (returns 0): no
// event is ever overwritten, so the caller need only drain the slot between
// steps.
int  nfc_step(nfc_reader_t *r);

// One-slot mailbox; false = none.
bool nfc_take_event(nfc_reader_t *r, nfc_event_t *out);

// While armed, the next tag ARRIVAL (debounce as for reads) is written with
// `disk_id` instead of read, whatever it holds, and reports WRITE_DONE with
// `seq`. Re-arming replaces the request. An id without the disk-id shape is
// refused with WRITE_DONE{seq, ok=false, why="bad data"} on the next step.
void nfc_arm_write(nfc_reader_t *r, uint32_t seq, const char *disk_id);
// Withdraws the armed write. A write already under way finishes and reports.
void nfc_disarm(nfc_reader_t *r);

// The chip answers (any state but ABSENT).
bool nfc_present(const nfc_reader_t *r);

#endif
