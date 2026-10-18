#ifndef NFC_READER_PRIV_H
#define NFC_READER_PRIV_H
// nfc_reader.c's insides, shared with its two chip backends (nfc_si512.c,
// nfc_pn532.c) and with the host tests. Not for callers: they use
// nfc_reader.h.
//
// The split: a backend moves a tag's bytes -- find a tag and its UID, prove
// key A, read or write one 16-byte block, switch the field off -- and hands
// every DECISION back to the session through the nfc_* helpers below. A
// backend never decides whether a tag is a new tap, what an event is, or
// whether a write verified; there is one copy of each of those, here.
//
// RULE: as nfc_reader.h -- C standard headers plus nfc_tag.h only.
#include "nfc_reader.h"

typedef enum {
    // The session's own (nfc_reader.c).
    ST_ABSENT,     // one presence check every 5 s: the Si512, then the PN532
    ST_REPORT,     // hand the finished event to the mailbox
    // The Si512 (nfc_si512.c).
    ST_RESET,      // PcdReset: SoftReset, then wait for PowerDown to clear
    ST_INIT,       // PCD_SI512_TypeA_Init
    ST_IDLE,       // field off until the next poll, then on and settle
    ST_REQ,        // PcdRequest(WUPA)
    ST_ANTICOLL,   // PcdAnticoll(level 1) and the debounce decision
    ST_SELECT,     // PcdSelect
    ST_AUTH,       // PcdAuthState(key A, sector 1)
    ST_READ,       // PcdRead x 3
    ST_WRITE,      // PcdWrite x 3
    ST_READBACK,   // PcdRead x 3 after a write
    ST_COM,        // subroutine: PcdComMF522
    ST_CRC,        // subroutine: CalulateCRC
    // The PN532 (nfc_pn532.c).
    ST_PN_INIT,    // SAMConfiguration, RFConfiguration (retries, field off)
    ST_PN_IDLE,    // field off, then wait for the next poll
    ST_PN_POLL,    // InListPassiveTarget and the debounce decision
    ST_PN_AUTH,    // InDataExchange MIFARE auth A, block 4
    ST_PN_READ,    // InDataExchange READ x 3
    ST_PN_WRITE,   // InDataExchange WRITE x 3
    ST_PN_READBACK,// InDataExchange READ x 3 after a write
    ST_PN_CMD,     // subroutine: one command, its ACK and its answer
} st_t;

#define POLL_MS     250   // spec §4.1: tag detection about every 250 ms
#define ABSENT_RECHECK_MS 5000   // spec §4.3
#define LOSS_FAILS    3   // consecutive failures = the chip is gone

// Sector 1 is blocks 4..7; 7 is the trailer and is never written.
#define FIRST_BLOCK 4
#define LAST_BLOCK  6

enum { MI_OK, MI_NOTAGERR, MI_ERR };

// ---- The session, for the backends (nfc_reader.c) --------------------------

void nfc_go(nfc_reader_t *r, st_t st);
// A subroutine call: the caller has set its own phase to resume at.
void nfc_call(nfc_reader_t *r, st_t sub);
void nfc_ret(nfc_reader_t *r);
// The chip answered a presence check: PRESENT, and the held tag re-anchored.
// The caller picks the next state.
void nfc_chip_found(nfc_reader_t *r);
// Back to the backend's idle state; `poll_now`: the next poll is due at once.
void nfc_enter_idle(nfc_reader_t *r, bool poll_now);
// In idle: true once the poll is due (and the hold expired if it ran out).
bool nfc_poll_due(nfc_reader_t *r);
// A poll found no tag: back to idle.
void nfc_empty_poll(nfc_reader_t *r);
// A poll found the tag in r->uid. true: a new arrival -- r->writing is
// decided and the backend runs it. false: the held tag again, the session has
// gone back to idle.
bool nfc_arrival(nfc_reader_t *r);
// The tag answered key A (true: r->block = FIRST_BLOCK; read or write by
// r->writing), or did not ("locked").
void nfc_auth_done(nfc_reader_t *r, bool ok);
// One block read: true = more to read (r->block advanced); false = the event
// is built (a decode, or the read-back's verify).
bool nfc_block_in(nfc_reader_t *r, const uint8_t b[16], bool readback);
// The 16 bytes for block r->block of the write in progress.
const uint8_t *nfc_block_out(const nfc_reader_t *r);
// One block written: true = more to write (r->block advanced); false = all
// written, r->block = FIRST_BLOCK for the read-back.
bool nfc_block_written(nfc_reader_t *r);
void nfc_finish(nfc_reader_t *r, nfc_ev_kind_t kind, const char *why);
// The tag stopped answering part-way: UNREADABLE / WRITE_DONE "moved".
void nfc_moved(nfc_reader_t *r);
// The chip is gone: ABSENT, and whatever was half-built goes with it.
void nfc_lose_chip(nfc_reader_t *r);
// While a PN532 runs (idle only): every ABSENT_RECHECK_MS one Si512 register
// read. true = the Si512 answered and the session is now the Si512's
// (ST_RESET); the caller returns.
bool nfc_si512_back(nfc_reader_t *r);

// ---- The backends -------------------------------------------------------------

// One register read (VersionReg): <0 = no Si512 answered.
int  si512_probe(nfc_reader_t *r);
bool si512_handle(nfc_reader_t *r);
// Begins trying the PN532 (state ST_PN_INIT, probing).
void pn532_probe(nfc_reader_t *r);
bool pn532_handle(nfc_reader_t *r);

// ---- The PN532 frame codec (nfc_pn532.c), pure, for the tests -----------------

// A normal information frame host -> PN532 (UM0701-02 §6.2.1.1):
// 00 00 FF LEN LCS D4 data... DCS 00. Returns its length, or -1 if it does
// not fit `cap` (or n is out of range).
int pn532_frame(uint8_t *out, int cap, const uint8_t *data, int n);

typedef enum {
    PN_OK,          // a normal frame from the PN532 with good checksums
    PN_ACK,         // the ACK frame (§6.2.1.3)
    PN_NOT_READY,   // the status byte's RDY bit is clear (§6.2.4)
    PN_SHORT,       // the header is good but the frame runs past what was read
    PN_BAD,         // anything else: no start code, a bad LCS or DCS, the
                    // syntax-error frame (§6.2.1.5), an extended frame
} pn_parse_t;

// Parses an I2C read: the status byte, then a frame (§6.2.4, Fig 30). Never
// reads past b[n - 1]. PN_OK: *at is the index of the frame's TFI and *len
// is LEN (TFI + data). PN_SHORT: *need is the read length that holds it all.
pn_parse_t pn532_parse(const uint8_t *b, int n, int *at, int *len, int *need);

#endif
