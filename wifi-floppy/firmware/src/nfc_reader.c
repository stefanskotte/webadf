// The session: one copy of everything a tap means, for both chips
// (nfc_reader.h). The chips' byte-moving lives in nfc_si512.c and
// nfc_pn532.c; they call back into the helpers here (nfc_reader_priv.h).
#include "nfc_reader_priv.h"
#include <string.h>

// ---- Timing ---------------------------------------------------------------

// The same UID is a new arrival only after this long continuously unseen.
// 1 s was not enough: a fob lying untouched at the edge of the antenna's
// range dropped out for over a second three times in 4.5 minutes on the
// bench (2026-09-26), and each return was a fresh tap -- a write landed on
// it, and it re-mounted its disk after a web eject. A tap is deliberate: a
// hand lifts the tag and brings it back, which takes longer than this.
#define NFC_REARRIVAL_ABSENT_MS 3000
// The Next-disk card's window. Its taps are the operator stepping through a
// set, one after another: on the bench (2026-10-18) the re-taps came about
// every 4 s with the card away 1.4-1.7 s, and under the 3 s window every one
// of them was "still the same tap" and did nothing. 1 s is under those gaps.
// It is counted as the reader sees it, poll to poll (~367 ms apart with no
// tag on the host model), so a lift counts up to one poll longer than it was:
// a lift of ~0.5-0.75 s or more is a new tap, one under ~0.47 s never is
// (test_nfc_reader.c pins both). The disk-tag reason for 3 s does
// not carry over: a Next card lying at the edge that re-triggers steps one
// disk on, it does not re-mount an ejected one -- and while a write is armed
// it gets the full 3 s anyway (hold_window).
#define NFC_REARRIVAL_ABSENT_NEXT_MS 1000
#define GAP_REPORT_MS            500   // a held tag's dropout longer than this is logged

// The field duty cycle: on only for a poll, off between polls -- both chips.
// It used to stay on non-stop, and two bench Si512 modules died after days
// of that (2026-10-03, and the replacement by 2026-10-08; HANDOFF 3bb).

// ---- Moving between states ------------------------------------------------

void nfc_go(nfc_reader_t *r, st_t st) {
    r->state = st;
    r->phase = r->pc = r->i = 0;
    r->tmp = -1;
}

static void emit(nfc_reader_t *r, const nfc_event_t *e) {
    r->ev = *e;
    r->has_ev = true;
}

// The caller sets its own phase to where it resumes BEFORE calling; the
// subroutine owns pc/i/tmp while it runs and hands back r->status.
void nfc_call(nfc_reader_t *r, st_t sub) {
    r->ret = r->state;
    r->state = sub;
    r->pc = r->i = 0;
    r->tmp = -1;
}

void nfc_ret(nfc_reader_t *r) {
    r->state = r->ret;
    r->pc = r->i = 0;
    r->tmp = -1;
}

// ---- Building the event ---------------------------------------------------------

void nfc_finish(nfc_reader_t *r, nfc_ev_kind_t kind, const char *why) {
    nfc_event_t *e = &r->built;
    memset(e, 0, sizeof *e);
    e->kind = kind;
    memcpy(e->uid, r->uid, NFC_UID_MAX);
    e->uid_len = r->uid_len;
    e->why = why;
    if (why) {                       // a failure's PN532 detail, if the backend recorded one
        e->pn_status = r->pn_err_status;
        e->pn_cmd = r->pn_err_cmd;
    }
    r->pn_err_status = r->pn_err_cmd = 0;
    if (kind == NFC_EV_WRITE_DONE) {
        e->seq = r->write_seq;
        e->ok = why == NULL;
    }
    nfc_go(r, ST_REPORT);
}

// The tag stopped answering part-way, or the chip reported an error. For a
// write this is "moved" whatever block it reached: blocks written before it
// are covered by the payload CRC, so the tag reads back as bad data, never
// as a wrong disk.
void nfc_moved(nfc_reader_t *r) {
    nfc_finish(r, r->writing ? NFC_EV_WRITE_DONE : NFC_EV_UNREADABLE, "moved");
}

// ---- The tap: hold windows, arrivals, gaps ---------------------------------------

// A held tag's detection gap, for the log (nfc_take_gap): measured from the
// last time it truly answered, which an arm's sighting does not move.
static void post_gap(nfc_reader_t *r, uint32_t now, bool new_arrival) {
    memcpy(r->gap.uid, r->last_uid, NFC_UID_MAX);
    r->gap.uid_len = r->last_uid_len;
    r->gap.ms = now - r->last_detect;
    r->gap.new_arrival = new_arrival;
    r->has_gap = true;
}

// How long the held tag must be unseen before the same UID is a new arrival.
// Decided here and only here: 1 s for a Next-disk card that was reported as
// a Next tap (held_next, set in st_report from the event it produced), 3 s
// for everything else -- a disk tag, a blank or foreign tag, an unreadable
// one, a tag just written. While a write is armed every held tag gets the 3 s:
// the arm gate (arm_gate) promises a tag lying on the reader is not written
// until a full window away, and a Next card is no exception.
static uint32_t hold_window(const nfc_reader_t *r) {
    return r->held_next && !r->armed ? NFC_REARRIVAL_ABSENT_NEXT_MS : NFC_REARRIVAL_ABSENT_MS;
}

// The held tag has been unseen for the whole re-arrival window: it has left,
// and the same UID seen from now on is a new arrival. Decided here and only
// here, so a poll and the anticoll after it cannot disagree about it.
static void expire_hold(nfc_reader_t *r, uint32_t now) {
    if (!r->held || now - r->last_seen < hold_window(r)) return;
    r->held = false;
    post_gap(r, now, true);          // the gap's one line: it ended the tap
}

// Every path back to idle passes here, so every one of them switches the
// field off: a poll with no tag, a finished tap, a collision. The backend's
// idle state does the switching; the poll clock is this one.
void nfc_enter_idle(nfc_reader_t *r, bool poll_now) {
    nfc_go(r, r->chip == NFC_CHIP_PN532 ? ST_PN_IDLE : ST_IDLE);
    r->t0 = r->now_ms() - (poll_now ? POLL_MS : 0);
}

bool nfc_poll_due(nfc_reader_t *r) {
    uint32_t now = r->now_ms();
    if (now - r->t0 < POLL_MS) return false;
    expire_hold(r, now);
    return true;
}

void nfc_empty_poll(nfc_reader_t *r) {
    // Only an empty poll makes a gap a dropout: at one op per pass a
    // held tag can go a long while between polls without ever leaving.
    if (r->held) r->missed = true;
    nfc_enter_idle(r, false);
}

bool nfc_arrival(nfc_reader_t *r) {
    // A tag held on the reader is seen every ~quarter second, and only its
    // ARRIVAL is a tap: the held UID seen again is the same tap until it has
    // been unseen for the whole re-arrival window.
    uint32_t now = r->now_ms();
    expire_hold(r, now);
    // The whole UID, and its length: two NTAGs can share their first four
    // bytes (the manufacturer byte and a serial prefix), and a 4-byte Classic
    // can match an NTAG's first four. Bytes past uid_len are zero on both
    // sides (nfc_uid_set), so the 7-byte compare is exact for a 4-byte UID.
    if (r->held && r->uid_len == r->last_uid_len && memcmp(r->uid, r->last_uid, NFC_UID_MAX) == 0) {
        if (r->missed && now - r->last_detect > GAP_REPORT_MS) post_gap(r, now, false);
        r->last_seen = r->last_detect = now;
        r->missed = false;
        nfc_enter_idle(r, false);
        return false;
    }
    // Read or write is decided here, once, from what was armed when the tag
    // arrived; a disarm or re-arm from now on does not change this tag's run.
    r->writing = r->armed;
    if (r->writing) {
        r->write_seq = r->arm_seq;
        memcpy(r->data, r->arm_payload, NFC_TAG_BYTES);
    }
    return true;
}

// ---- The tag's blocks -------------------------------------------------------------

void nfc_uid_set(nfc_reader_t *r, const uint8_t *b, int n) {
    if (n > NFC_UID_MAX) n = NFC_UID_MAX;
    memset(r->uid, 0, NFC_UID_MAX);
    memcpy(r->uid, b, (size_t)n);
    r->uid_len = (uint8_t)n;
}

nfc_kind_t nfc_classify(int uid_len, uint8_t sak) {
    // SAK bit 3 is MIFARE Classic (08 the 1K; 18 the 4K and 09 the Mini have
    // a sector 1 too and were always read). A Type 2 tag's final SAK is 00.
    // A 7-byte Classic, a DESFire, an ISO-DEP card (SAK bit 5): none of these.
    if (uid_len == 4 && (sak & 0x08)) return NFC_KIND_CLASSIC;
    if (uid_len == 7 && sak == 0x00) return NFC_KIND_T2;
    return NFC_KIND_NONE;
}

bool nfc_tag_selected(nfc_reader_t *r, uint8_t sak) {
    r->kind = (uint8_t)nfc_classify(r->uid_len, sak);
    if (r->kind == NFC_KIND_NONE) {
        nfc_finish(r, NFC_EV_NOT_SUPPORTED, NULL);
        return false;
    }
    if (r->kind == NFC_KIND_T2) {      // no Crypto1: the blocks are open
        r->block = FIRST_BLOCK;
        r->sub = 0;
    }
    return true;
}

uint8_t nfc_read_addr(const nfc_reader_t *r) {
    if (r->kind == NFC_KIND_T2) return (uint8_t)(T2_FIRST_PAGE + (r->block - FIRST_BLOCK) * 4);
    return (uint8_t)r->block;
}

int nfc_t2_page(const nfc_reader_t *r) {
    int pg = T2_FIRST_PAGE + (r->block - FIRST_BLOCK) * 4 + r->sub;
    // The one gate on a Type 2 page number: nothing outside the payload's
    // pages -- never 0-3, never a lock or configuration page.
    return pg >= T2_FIRST_PAGE && pg <= T2_LAST_PAGE ? pg : -1;
}

const uint8_t *nfc_t2_page_out(const nfc_reader_t *r) {
    return nfc_block_out(r) + r->sub * 4;
}

bool nfc_t2_page_written(nfc_reader_t *r) {
    if (++r->sub < 4) return true;
    r->sub = 0;
    return nfc_block_written(r);
}

void nfc_write_refused(nfc_reader_t *r) {
    nfc_finish(r, NFC_EV_WRITE_DONE, "locked");
}

void nfc_auth_done(nfc_reader_t *r, bool ok) {
    // A wrong key, or a tag that left during the auth: either way "locked".
    if (!ok) {
        nfc_finish(r, r->writing ? NFC_EV_WRITE_DONE : NFC_EV_UNREADABLE, "locked");
        return;
    }
    r->block = FIRST_BLOCK;
}

bool nfc_block_in(nfc_reader_t *r, const uint8_t b[16], bool readback) {
    uint8_t *dst = readback ? r->back : r->data;
    memcpy(dst + (r->block - FIRST_BLOCK) * 16, b, 16);
    if (r->block < LAST_BLOCK) {
        r->block++;
        return true;
    }
    if (readback) {
        // Byte-identical, all 48, or it did not happen.
        nfc_finish(r, NFC_EV_WRITE_DONE, memcmp(r->back, r->data, NFC_TAG_BYTES) == 0 ? NULL : "verify");
        return false;
    }
    char id[NFC_DISK_ID_LEN + 1];
    nfc_tag_result_t res = nfc_tag_decode(r->data, id);
    if (res == NFC_TAG_OK) {
        nfc_finish(r, NFC_EV_TAG_READ, NULL);
        memcpy(r->built.disk_id, id, sizeof id);
    } else if (res == NFC_TAG_NEXT) {
        // No disk id to carry -- nfc_finish() already zeroed built.disk_id,
        // so it comes out empty. Same presence gating as TAG_READ, decided
        // in the same place, but held it re-arrives after 1 s, not 3 s
        // (hold_window).
        nfc_finish(r, NFC_EV_TAG_NEXT, NULL);
    } else if (res == NFC_TAG_NOT_OURS) {
        nfc_finish(r, NFC_EV_NOT_OURS, NULL);
    } else {
        nfc_finish(r, NFC_EV_UNREADABLE, "bad data");
    }
    return false;
}

const uint8_t *nfc_block_out(const nfc_reader_t *r) {
    return r->data + (r->block - FIRST_BLOCK) * 16;
}

bool nfc_block_written(nfc_reader_t *r) {
    if (r->block < LAST_BLOCK) {
        r->block++;
        return true;
    }
    r->block = FIRST_BLOCK;
    return false;
}

// ---- Presence ----------------------------------------------------------------------

void nfc_chip_found(nfc_reader_t *r) {
    uint32_t now = r->now_ms();
    // The chip is back. While it was gone nothing could see the held tag, so
    // its absence says nothing about the tag: the return counts as a sighting,
    // and a working chip must find it gone for the whole window. Without this
    // the 5 s recheck alone expires the hold, and a tag that never moved is a
    // new arrival -- written over if armed, its disk re-mounted if not -- and
    // logged as a tag gap it never had.
    if (r->held) r->last_seen = r->last_detect = now;
    r->missed = false;
    nfc_event_t e = { .kind = NFC_EV_PRESENT };
    emit(r, &e);
}

// One presence check every 5 s: the Si512 at 0x28 first (one register read),
// and only if it is silent the PN532 at 0x24, on the next step -- so a board
// with both talks to the Si512, as every board did before 1.18.0. A Si512
// plugged in late is found at the next check. The PN532 is tried only when
// it was attached, which main.c does only if the boot I2C scan saw 0x24: a
// board with another device there (an MCP23017, a PCF8574) never has a frame
// written to it -- and so a PN532 plugged in after boot needs a restart.
// The Si512 is the preferred chip whenever it answers -- the one every board
// before 1.18.0 used. Without this a board with both fitted would move to the
// PN532 for good after one missed Si512 recheck (a loose lead, a brown-out):
// the PN532 then answers every poll and is never lost. So while the PN532
// runs, the Si512 is still asked every 5 s, and it takes the session back the
// moment it answers. The held tag carries over: both chips report the same UID.
bool nfc_si512_back(nfc_reader_t *r) {
    uint32_t now = r->now_ms();
    if (now - r->t_si512 < ABSENT_RECHECK_MS) return false;
    r->t_si512 = now;
    int v = si512_probe(r);
    r->fails = 0;                    // a missing Si512 is no fault of the PN532's
    if (v < 0) return false;
    r->chip = NFC_CHIP_SI512;
    r->pn_field = r->pn_target = false;
    nfc_go(r, ST_RESET);
    return true;
}

static bool st_absent(nfc_reader_t *r) {
    if (r->pn_probe_due) {
        r->pn_probe_due = false;
        pn532_probe(r);              // ST_PN_INIT, probing: PRESENT once it answers
        return true;
    }
    uint32_t now = r->now_ms();
    if (r->checked_once && now - r->t0 < ABSENT_RECHECK_MS) return false;
    r->checked_once = true;
    r->t0 = now;
    int v = si512_probe(r);
    r->fails = 0;                    // silence is what ABSENT expects
    if (v < 0) {
        r->pn_probe_due = r->has_fbus;
        return false;
    }
    r->chip = NFC_CHIP_SI512;
    nfc_go(r, ST_RESET);
    nfc_chip_found(r);
    return false;
}

static bool st_report(nfc_reader_t *r) {
    // The tap is now reported: from here on, this UID held on the reader is
    // the same tap. Anchored at NOW, not at the anticoll that began it: at
    // one register op per pass (a mounted disk at 100 kHz) a read can take
    // over a second from anticoll to here, and an anchor that old would eat
    // into the re-arrival window before the tag had been polled even once.
    r->held = true;
    r->held_next = r->built.kind == NFC_EV_TAG_NEXT;   // its window: hold_window
    memcpy(r->last_uid, r->uid, NFC_UID_MAX);
    r->last_uid_len = r->uid_len;
    r->last_seen = r->last_detect = r->now_ms();
    r->missed = false;
    if (r->built.kind == NFC_EV_WRITE_DONE && r->armed && r->arm_seq == r->built.seq)
        r->armed = false;            // only the request that ran; a newer one stays
    r->writing = false;
    emit(r, &r->built);
    nfc_enter_idle(r, false);
    return false;
}

// Three failed transfers in a row: the chip is gone. Whatever was half-built
// goes with it -- a tag read that did not finish reports nothing.
void nfc_lose_chip(nfc_reader_t *r) {
    nfc_go(r, ST_ABSENT);
    r->chip = NFC_CHIP_NONE;
    r->probing = r->pn_probe_due = r->pn_field = r->pn_target = false;
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
    case ST_ABSENT: return st_absent(r);
    case ST_REPORT: return st_report(r);
    default:        return r->chip == NFC_CHIP_PN532 ? pn532_handle(r) : si512_handle(r);
    }
}

// ---- API ----------------------------------------------------------------------

void nfc_init(nfc_reader_t *r, const nfc_bus_t *bus, uint32_t (*now_ms)(void)) {
    memset(r, 0, sizeof *r);
    r->bus = *bus;
    r->now_ms = now_ms;
    r->max_ops = NFC_MAX_OPS_PER_STEP;
    nfc_go(r, ST_ABSENT);
}

void nfc_attach_pn532(nfc_reader_t *r, const nfc_frame_bus_t *fbus) {
    r->fbus = *fbus;
    r->has_fbus = true;
}

void nfc_disable(nfc_reader_t *r) {
    r->disabled = true;
}

int nfc_step(nfc_reader_t *r) {
    r->ops = 0;
    if (r->disabled) return 0;
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
            nfc_lose_chip(r);
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

// The gating shared by every arm call, whatever the payload: a tag held
// right now was on the reader before the write existed, so the arm counts
// as a sighting of it, and it is written only after a full window away that
// began after the arm -- even if it was already part-way through a dropout.
// A different tag is still written at once. While the chip is ABSENT (or a
// PN532 is only being tried) the hold cannot expire (see st_absent): the chip's return decides it, not
// this call. nfc_arm_write and nfc_arm_write_next must never drift apart
// here -- this is the one gate that stops a write landing on a tag already
// on the reader.
static void arm_gate(nfc_reader_t *r, uint32_t seq) {
    uint32_t now = r->now_ms();
    if (nfc_present(r)) expire_hold(r, now);
    if (r->held) r->last_seen = now;
    r->arm_seq = seq;
}

void nfc_arm_write(nfc_reader_t *r, uint32_t seq, const char *disk_id) {
    arm_gate(r, seq);
    r->armed = disk_id != NULL && nfc_tag_encode(disk_id, r->arm_payload);
    r->arm_bad = !r->armed;
}

void nfc_arm_write_next(nfc_reader_t *r, uint32_t seq) {
    // Identical gating to nfc_arm_write; only the payload differs, and
    // nfc_tag_encode_next always succeeds, so this never arms "bad".
    arm_gate(r, seq);
    r->armed = nfc_tag_encode_next(r->arm_payload);
    r->arm_bad = !r->armed;
}

void nfc_disarm(nfc_reader_t *r) {
    r->armed = false;
    r->arm_bad = false;
}

bool nfc_present(const nfc_reader_t *r) {
    return r->state != ST_ABSENT && !r->probing;
}

nfc_chip_t nfc_chip(const nfc_reader_t *r) {
    return nfc_present(r) ? (nfc_chip_t)r->chip : NFC_CHIP_NONE;
}

void nfc_set_max_ops(nfc_reader_t *r, int cap) {
    r->max_ops = cap < 1 ? 1 : cap > NFC_MAX_OPS_PER_STEP ? NFC_MAX_OPS_PER_STEP : cap;
}
