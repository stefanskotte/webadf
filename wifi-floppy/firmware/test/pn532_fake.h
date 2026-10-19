#ifndef PN532_FAKE_H
#define PN532_FAKE_H
// A frame-level model of an NXP PN532 on I2C with one scripted ISO 14443A
// tag, for the reader's host tests -- the PN532 counterpart of si512_fake.c.
// Every rule below is from UM0701-02 (PN532 User Manual, Rev. 02); it models
// what the reader's correctness depends on, and those parts honestly:
//   - a write is one whole command frame, 00 00 FF LEN LCS D4 ... DCS 00
//     (§6.2.1.1); a frame with a bad LCS or DCS gets no ACK (§6.2.2.1 b);
//   - every read starts with the status byte, RDY = 0x01 only when a frame
//     is waiting (§6.2.4); the frame follows in the SAME read, and whatever a
//     read leaves unread is lost (§6.2.4);
//   - a command is ACKed (§6.2.1.3), then answered; a NACK from the host
//     re-sends the last answer (§6.2.2.1 c); an ACK from the host aborts the
//     command in progress and nothing is answered (§6.2.2.1 d);
//   - after power-up the chip is in LowVbat and does nothing until
//     SAMConfiguration (§3.1.3.3); this model ignores every other command
//     before it -- stricter than the manual says, so a reader that skips it
//     fails here;
//   - InListPassiveTarget retries MxRtyPassiveActivation times, 0xFF
//     (forever) by default (§7.3.1 CfgItem 5, §7.3.5): with the default and no
//     tag it never answers. With no tag it switches the field off itself
//     (§3.1.3.10); with a tag the field stays on;
//   - InListPassiveTarget probes with SENS_REQ (REQA) (§7.3.5): it wakes an
//     IDLE tag, not a HALTed one, and a tag is reset to IDLE only by the
//     field going off;
//   - InDataExchange carries MIFARE Classic auth (0x60), READ (0x30) and
//     WRITE (0xA0) (§7.3.8); its status byte is the §7.1 error code: 0x14 a
//     failed auth, 0x01 a tag that did not answer (after the 51.2 ms default
//     timeout, §7.3.1 CfgItem 2);
//   - a Type 2 tag (pn532_fake_ntag: NTAG213/215/216) is a "Mifare" target
//     too: InListPassiveTarget reports its whole 7-byte UID and the final SAK
//     0x00; InDataExchange READ 0x30 answers four pages and "0xA2 4 bytes
//     writing" (§7.3.8) one page. A page the tag NAKs answers status 0x14:
//     the manual does not say which code a Type 2 NAK becomes, and 0x14 is
//     what libnfc reports for one -- a modelling choice, flagged as such.
#include <stdbool.h>
#include <stdint.h>
#include "../src/nfc_reader.h"

typedef struct {
    // --- the script ---
    bool    chip_present;      // answers at 0x24 at all
    bool    tag_present;
    uint8_t uid[10];
    int     uid_len;           // 4 (MIFARE Classic 1K), 7 or 10
    uint8_t sak;               // 0x08: MIFARE Classic 1K
    int     ats_len;           // > 0: an ISO 14443-4 card's ATS of this many bytes in TargetData
    uint8_t sector1[48];       // blocks 4, 5, 6
    bool    locked;            // key A is not FF..FF
    // A Type 2 tag (ntag_pages > 0; pn532_fake_ntag): pages of 4 bytes.
    int     ntag_pages;        // 45 NTAG213, 135 NTAG215, 231 NTAG216; 0 = a Classic tag
    uint8_t mem[231 * 4];
    bool    write_protected;   // every WRITE is NAKed
    bool    flip_next_read;    // the next READ answers with one bit flipped
    int     tag_leaves_after_cmds;   // -1 never; once N commands have arrived the tag is gone
    int     vanish_after_xfers;      // -1 never; from transfer N on every transfer fails
    int     garble_next;       // the next N answers go out with a bad DCS (a NACK gets a good copy)
    int     bad_len_next;      // > 0: the next answer's LEN claims this (LCS to match), body unchanged
    bool    never_answer;      // commands are ACKed but never answered (a wedged chip)
    const uint32_t *clock;     // the test's clock (ms); required

    // --- what the reader did ---
    int  xfers;                // every wr/rd call, failed ones included
    int  status_reads;         // reads of 1 byte (status polls)
    int  max_xfer;             // the longest transfer, in bytes
    int  max_step_frames;      // see pn532_fake_step_begin
    int  cmds[256];            // commands received (well-formed), by code
    int  host_acks;            // aborts the host sent
    int  host_nacks;           // NACKs the host sent
    int  retries_passive;      // MxRtyPassiveActivation as configured (0xFF default)
    bool sam_done;
    int  reads;                // READs the tag answered
    int  page_writes;          // Type 2 WRITEs (0xA2) the tag accepted
    int  low_page_writes;      // Type 2 WRITEs aimed at pages 0-3: must stay 0
    int  cfg_page_writes;      // Type 2 WRITEs aimed at the dynamic lock / config pages: must stay 0
    int  max_page_written;     // -1
    int  compat_writes;        // InDataExchange 0xA0 to a Type 2 tag: never used, must stay 0
    int  trailer_writes;       // WRITEs aimed at block 7 (must stay 0)
    int  ilpt_found;           // InListPassiveTarget answers with a tag
    uint32_t field_on_ms;      // total time the field has been on (closed intervals)
    uint32_t bus_hz;           // the I2C clock: 100 kHz (the boot probe's) until the reader asks for more
    int  hz_requests;          // set_hz calls
    uint32_t lowest_hz_asked;  // the slowest clock ever asked for (0 = never asked)
    int  slow_frames;          // frame transfers made below 400 kHz
    uint32_t step_us;          // bus time of the current step (pn532_fake_step_begin resets it)
    uint32_t max_step_us;      // the longest step on the bus since max_step_us was last zeroed

    // --- the chip (private) ---
    bool     field;
    uint32_t field_on_at;
    int      tag_state;        // 0 idle, 1 halted, 2 active, 3 authenticated
    int      ncmds;
    uint8_t  q[96];            // the frame waiting to be read (ACK or answer)
    int      q_n;
    uint32_t q_at;             // ready from this time
    bool     q_is_ack;
    uint8_t  ans[96];          // the answer queued behind the ACK
    int      ans_n;
    uint32_t ans_delay;
    bool     ans_pending;
    uint8_t  last[96];         // the last answer, for a NACK
    int      last_n;
    int      step_frames;
} pn532_fake_t;

// A present, awake-on-demand chip with a present tag holding zeros, UID
// DE AD BE EF, SAK 08, nothing scheduled to fail.
void pn532_fake_init(pn532_fake_t *f, const uint32_t *clock);

nfc_frame_bus_t pn532_fake_bus(pn532_fake_t *f);

// A factory-fresh Type 2 tag, as si512_fake_ntag.
void pn532_fake_ntag(pn532_fake_t *f, int pages, const uint8_t uid[7]);

// Total field-on time so far, including the interval still open.
uint32_t pn532_fake_field_on_ms(const pn532_fake_t *f);

// Call before each nfc_step: max_step_frames records the most frame
// transfers (anything but a 1-byte status read) any one step made, and
// max_step_us the most bus time: (bytes + the address byte) x 9 bits at
// bus_hz, per transfer.
void pn532_fake_step_begin(pn532_fake_t *f);

#endif
