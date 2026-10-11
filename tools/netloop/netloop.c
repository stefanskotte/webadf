/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/*
 * NetLoop -- the PaulaNET track-77 loopback probe for the A500 (PaulaNET-on-DF1, Phase 0).
 * Plan: docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md in the webadf repository.
 *
 * Implemented from the protocol's description; none of RobSmithDev's code is in this program.
 *
 * Each round writes a batch of N payload bytes to DF1 cylinder 77 side 0 (ETD_RAWWRITE), reads
 * the board's echo from side 1 (ETD_RAWREAD with IOTDF_INDEXSYNC, then software bit alignment),
 * and checks every byte. READS=2 (default) reads as PaulaNET's own driver does: a 1,024-byte
 * header read, a seek back to side 0, then a read sized from the header. READS=1 reads once,
 * sized for the echo NetLoop expects. Times come from timer.device's E-clock.
 *
 *   NetLoop [N=<bytes>] [ROUNDS=<n>] [READS=1|2] [DIAG] [SELFTEST] [BENCH]
 *   NetLoop DHCP MAC=<board mac>                         (Phase 1: a lease from the router)
 *   NetLoop ARP MAC=<board mac> [IP=<a>] [ROUTER=<r>] [ROUNDS=<n>]   (Phase 1: the router's MAC)
 * ARP/DHCP need the PaulaNET Phase 1 TEST firmware (the board's boot log prints its MAC). DHCP saves
 * the lease as the global variables NetLoopIP and NetLoopRouter, which ARP uses when IP= and ROUTER=
 * are not given.
 *
 * The summary splits the no-sync and bad-header retries by read (the 1,024-byte header read, the
 * payload read), gives a bad header's kind, and histograms the sync's byte offset per read. DIAG
 * over-reads each payload read by one echo loop and scans all of it for the sync, so a read that
 * starts past the sync still finds the next one and shows where it started; the default read
 * pattern (PaulaNET's driver's) is unchanged without it.
 *
 * SELFTEST: no drive; the codec round trip, then the asm codec against the C reference on this
 * CPU. BENCH: no drive; each codec stage, C and asm, timed with the E-clock (netloop_bench.h).
 * The codec is pnet_asm.S unless build.sh built it with NETLOOP_CODEC=c.
 */
#include <exec/types.h>
#include <exec/memory.h>
#include <exec/io.h>
#include <devices/trackdisk.h>
#include <devices/timer.h>
#include <dos/dos.h>
#include <dos/rdargs.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/timer.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "pnet_mfm.h"
#include "pnet_frame.h"
#include "netloop_stats.h"
#include "pnet_asm.h"
#include "netloop_equiv.h"
#include "netloop_bench.h"
#include "netloop_eth.h"
#include <dos/var.h>

#ifndef NETLOOP_ASM
#define NETLOOP_ASM 1
#endif
#if NETLOOP_ASM
#define payload_equal(a, b, n) nl_memeq_asm((a), (b), (n))
#define CODEC_NAME "asm"
#else
#define payload_equal(a, b, n) (memcmp((a), (b), (n)) == 0)
#define CODEC_NAME "C"
#endif

static const char vers[] __attribute__((used)) =
    "$VER: NetLoop 1.2 (11.10.2026) PaulaNET protocol by RobSmithDev, used with permission";

#define DF1_UNIT    1
#define CHIP_BYTES  16896u    /* the largest write or read, rounded up */
#define ECHO_BYTES  16384u
#define MAX_N       12000u    /* the board's echo must fit DF1's 14,336-byte stream buffer */
#define MAX_ROUNDS  1000u
#define SYNC_SCAN   512u
#define HDR_READ    1024u     /* PaulaNET's driver reads at least this much for a header */
#define SEEK_TO(t)  ((ULONG)(t) * NUMSECS * TD_SECTOR)

struct Device *TimerBase;

static struct MsgPort *port;
static struct IOExtTD *td;
static struct timerequest *treq;
static BOOL td_open, timer_open;
static UBYTE *wbuf, *rbuf;    /* CHIP: Paula's disk DMA reads and writes these */
static UBYTE *payload, *echo;
static uint32_t *rtt;
static ULONG hz = 709379;

/* unsigned long, not ULONG: this NDK's ULONG is unsigned int, and printf's %lu wants long. */
static unsigned long c_ioerr, c_nosync, c_badhdr, c_stale, c_rewrites, c_mismatch, c_failed;
/* Per read kind (0 the header read, 1 the payload read): no sync; bad header by kind (short,
 * checksum, magic, other); the sync's byte offset in 8-byte bins, the last bin 128 and up. */
#define RK_HDR 0
#define RK_PAY 1
#define BAD_KINDS 4
#define OFF_BINS 17
static unsigned long c_nosync_k[2], c_bad_k[2][BAD_KINDS], c_off_k[2][OFF_BINS];
static BOOL diag;
static unsigned long late_off[8];   /* DIAG: the first payload-read sync offsets past 127 bytes */
static unsigned n_late;
static uint64_t t_write, t_read, t_align, t_build;

static uint64_t ticks(void) {
    struct EClockVal ev;
    hz = ReadEClock(&ev);
    return ((uint64_t)ev.ev_hi << 32) | ev.ev_lo;
}

static void ms(uint64_t t, unsigned long *whole, unsigned long *tenth) {
    const unsigned long v = nl_tenths(t * 1000u, hz);
    *whole = v / 10u;
    *tenth = v % 10u;
}

static BYTE td_io(UWORD cmd, UBYTE flags, APTR data, ULONG len, ULONG offset) {
    td->iotd_Req.io_Command = cmd;
    td->iotd_Req.io_Flags = flags;
    td->iotd_Req.io_Data = data;
    td->iotd_Req.io_Length = len;
    td->iotd_Req.io_Offset = offset;
    td->iotd_Count = 0xFFFFFFFFul;   /* no disk-change count check, as PaulaNET's driver */
    return DoIO((struct IORequest *)td);
}

/* One INDEXSYNC read of `len` bytes from side 1: aligned, header decoded. 0 = usable. The sync
 * must start in the first SYNC_SCAN bytes, or anywhere with `scan_all` (DIAG payload reads). */
static int read_once(ULONG len, pnet_hdr_t *h, BOOL with_payload, size_t *valid, BOOL scan_all) {
    const int rk = with_payload ? RK_PAY : RK_HDR;
    const uint64_t t0 = ticks();
    if (td_io(ETD_RAWREAD, IOTDF_INDEXSYNC, rbuf, len, PNET_TRACK_OUT)) { c_ioerr++; return 1; }
    const uint64_t t1 = ticks();
    t_read += t1 - t0;
    const long off = pnet_find_sync(rbuf, len, scan_all ? len : SYNC_SCAN);
    if (off < 0) { c_nosync++; c_nosync_k[rk]++; return 1; }
    const unsigned long ob = (unsigned long)off >> 3;
    c_off_k[rk][ob >= 128u ? OFF_BINS - 1u : ob >> 3]++;
    if (scan_all && ob >= 128u && n_late < 8u) late_off[n_late++] = ob;
    size_t span = with_payload ? len : (size_t)ob + PNET_HDR_MFM_BYTES + 1u;
    if (span > len) span = len;
    *valid = pnet_shift_left(rbuf, span, (size_t)off);
    const pnet_err_t e = pnet_parse_hdr_to_amiga(rbuf, *valid, h, with_payload);
    t_align += ticks() - t1;
    if (e != PNET_OK) {
        c_badhdr++;
        c_bad_k[rk][e == PNET_E_SHORT ? 0 : e == PNET_E_CHECKSUM ? 1 : e == PNET_E_MAGIC ? 2 : 3]++;
        return 1;
    }
    return 0;
}

/* 0 = the echo matches, 2 = it answered but differs. */
static int check_echo(const pnet_hdr_t *h, const uint16_t *lens, unsigned nf, ULONG n) {
    uint16_t el[PNET_MAX_FRAMES];
    unsigned en = 0;
    if (pnet_parse_frames(rbuf + PNET_HDR_MFM_BYTES, h->data_size, PNET_TO_AMIGA, echo, ECHO_BYTES,
                          el, PNET_MAX_FRAMES, &en) != PNET_OK) { c_mismatch++; return 2; }
    if (en != nf) { c_mismatch++; return 2; }
    for (unsigned i = 0; i < nf; i++) if (el[i] != lens[i]) { c_mismatch++; return 2; }
    if (!payload_equal(echo, payload, n)) { c_mismatch++; return 2; }
    return 0;
}

/* Up to three tries at reading this round's echo. 1 = none answered. */
static int read_echo(UBYTE ctr, UBYTE last_pico, const uint16_t *lens, unsigned nf, ULONG n,
                     ULONG reads, pnet_hdr_t *h) {
    for (int r = 0; r < 3; r++) {
        size_t valid;
        ULONG len;
        if (reads == 2) {
            if (read_once(HDR_READ, h, FALSE, &valid, FALSE)) continue;
            if (!nl_echo_answers(h->amiga_ctr, h->pico_ctr, ctr, last_pico)) { c_stale++; continue; }
            td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(PNET_TRACK_IN));   /* as PaulaNET's driver does */
            len = (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h->data_size + 64u + 1u) & ~1ul;
            if (diag)   /* one more echo loop */
                len += PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h->data_size + PNET_TRAIL_BYTES;
        } else {
            len = ((ULONG)pnet_to_amiga_bound(lens, nf) - PNET_TRAIL_BYTES + 32u + 1u) & ~1ul;
            if (diag) len += (ULONG)pnet_to_amiga_bound(lens, nf);
        }
        len &= ~1ul;
        if (len > CHIP_BYTES) len = CHIP_BYTES;
        if (read_once(len, h, TRUE, &valid, diag)) continue;
        if (!nl_echo_answers(h->amiga_ctr, h->pico_ctr, ctr, last_pico)) { c_stale++; continue; }
        return check_echo(h, lens, nf, n);
    }
    return 1;
}

/* One round: 0 ok, 1 failed, 2 mismatch. *took = its E-clock ticks. */
static int one_round(UBYTE *ctr, UBYTE *last_pico, ULONG n, ULONG reads, ULONG seed, uint32_t *took) {
    uint16_t lens[PNET_MAX_FRAMES];
    pnet_frame_ref_t refs[PNET_MAX_FRAMES];
    unsigned nf;
    nl_split(n, lens, &nf);
    nl_fill(seed, payload, n);
    ULONG off = 0;
    for (unsigned i = 0; i < nf; i++) { refs[i].data = payload + off; refs[i].len = lens[i]; off += lens[i]; }
    *ctr = (UBYTE)(*ctr + 1u);
    const uint64_t t0 = ticks();   /* the window opens before the encode: it is part of a round */
    const size_t wlen = pnet_build_to_board(wbuf, CHIP_BYTES, *ctr, *last_pico, refs, nf);
    t_build += ticks() - t0;
    if (!wlen) { *took = 0; return 1; }
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    int res = 1;
    for (int attempt = 0; attempt < 3 && res == 1; attempt++) {
        if (attempt) c_rewrites++;
        const uint64_t w0 = ticks();
        // A first write can find WPROT not yet released (PaulaNET's driver retries once too).
        if (td_io(ETD_RAWWRITE, 0, wbuf, wlen, PNET_TRACK_IN) &&
            td_io(ETD_RAWWRITE, 0, wbuf, wlen, PNET_TRACK_IN)) { c_ioerr++; continue; }
        t_write += ticks() - w0;
        res = read_echo(*ctr, *last_pico, lens, nf, n, reads, &h);
    }
    *took = (uint32_t)(ticks() - t0);
    if (res != 1) *last_pico = h.pico_ctr;   /* it answered: acknowledge it next round */
    return res;
}

/* Learn the board's counters, so a restarted NetLoop's first batch is new to it. */
static BOOL resync(UBYTE *ctr, UBYTE *last_pico, BOOL l2) {
    pnet_hdr_t h;
    size_t valid;
    *ctr = 0xFFu;
    *last_pico = 0xFFu;
    td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(PNET_TRACK_IN));   /* onto cylinder 77: WPROT releases */
    if (read_once(HDR_READ, &h, FALSE, &valid, FALSE) == 0) {
        *ctr = nl_start_ctr(TRUE, h.amiga_ctr);
        /* The loopback modes acknowledge what they find. The L2 modes must not: a batch the board has
         * out under pico P is freed when a write echoes P, and resync discarded its frames. Start one
         * behind, so the first write acknowledges nothing and l2_exchange reads that batch as new. */
        *last_pico = l2 ? nl_l2_start_ack(h.pico_ctr) : h.pico_ctr;
        return TRUE;
    }
    return FALSE;
}

/* ---- Phase 1: real frames (ARP, DHCP) ---------------------------------------------------- */
static uint8_t l2_mac[6];
static unsigned long c_l2_frames, c_l2_stale, c_l2_unacked;
typedef int (*l2_fn)(const uint8_t *f, size_t len, void *ctx);   /* nonzero: the frame wanted */

/* One exchange: our batch on side 0 (out, or none: a poll that also acknowledges), then side 1
 * until the board's header acknowledges it; a new batch's frames go to fn (NULL: counted only).
 * 0 = fn found its frame, 1 = acknowledged, nothing found, 2 = not acknowledged (send again). */
static int l2_exchange(UBYTE *ctr, UBYTE *last_pico, const pnet_frame_ref_t *out, unsigned nout,
                       l2_fn fn, void *ctx) {
    *ctr = (UBYTE)(*ctr + 1u);                       /* every write is a new batch (ruling 14) */
    const size_t wlen = pnet_build_to_board(wbuf, CHIP_BYTES, *ctr, *last_pico, out, nout);
    if (!wlen) return 2;
    if (td_io(ETD_RAWWRITE, 0, wbuf, wlen, PNET_TRACK_IN) &&
        td_io(ETD_RAWWRITE, 0, wbuf, wlen, PNET_TRACK_IN)) { c_ioerr++; return 2; }
    for (int r = 0; r < 3; r++) {
        pnet_hdr_t h, p;
        size_t valid;
        if (read_once(HDR_READ, &h, FALSE, &valid, FALSE)) continue;
        if (h.amiga_ctr != *ctr) { c_l2_stale++; continue; }
        if (h.pico_ctr == *last_pico || h.data_size == 0) return 1;
        td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(PNET_TRACK_IN));            /* as PaulaNET's driver does */
        ULONG len = (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h.data_size + 64u + 1u) & ~1ul;
        if (len > CHIP_BYTES) len = CHIP_BYTES;
        if (read_once(len, &p, TRUE, &valid, FALSE) || p.pico_ctr != h.pico_ctr) continue;
        uint16_t lens[PNET_MAX_FRAMES];
        unsigned n = 0;
        if (pnet_parse_frames(rbuf + PNET_HDR_MFM_BYTES, p.data_size, PNET_TO_AMIGA, echo, ECHO_BYTES,
                              lens, PNET_MAX_FRAMES, &n) != PNET_OK) { c_badhdr++; continue; }
        *last_pico = p.pico_ctr;                                       /* our next write acknowledges it */
        int found = 0;
        const uint8_t *q = echo;
        for (unsigned i = 0; i < n; i++) {
            c_l2_frames++;
            if (!found && fn && fn(q, lens[i], ctx)) found = 1;
            q += lens[i];
        }
        return found ? 0 : 1;
    }
    c_l2_unacked++;
    return 2;
}

/* Sends `frame` until the board takes it, then polls until fn finds its reply or wait_s pass.
 * The send exchange is matched too: the board builds a batch whenever frames arrive while nothing
 * is out, and that includes the gap between our write and our side-1 read, so a fast reply can
 * already be in the batch that read returns (and our next write would acknowledge it away).
 * 0 = found (*took: E-clock ticks from the first write), 1 = not found. */
static int l2_ask(UBYTE *ctr, UBYTE *last_pico, const uint8_t *frame, size_t flen, l2_fn fn,
                  void *ctx, ULONG wait_s, uint32_t *took) {
    const pnet_frame_ref_t ref = { frame, (uint16_t)flen };
    const uint64_t t0 = ticks(), end = t0 + (uint64_t)wait_s * hz;
    BOOL sent = FALSE;
    while (ticks() < end) {
        if (SetSignal(0, 0) & SIGBREAKF_CTRL_C) return 1;
        const int r = l2_exchange(ctr, last_pico, sent ? NULL : &ref, sent ? 0u : 1u, fn, ctx);
        if (r == 0) { *took = (uint32_t)(ticks() - t0); return 0; }
        if (r != 2) sent = TRUE;
    }
    return 1;
}

typedef struct { uint32_t asked; uint8_t mac[6]; } arp_ctx_t;
static int arp_fn(const uint8_t *f, size_t len, void *ctx) {
    arp_ctx_t *a = ctx;
    return nl_arp_reply_from(f, len, a->asked, a->mac);
}

typedef struct { uint32_t xid; uint8_t want; nl_dhcp_t d; } dhcp_ctx_t;
static int dhcp_fn(const uint8_t *f, size_t len, void *ctx) {
    dhcp_ctx_t *c = ctx;
    nl_dhcp_t d;
    if (!nl_dhcp_parse(f, len, c->xid, &d)) return 0;
    if (d.type != c->want && !(c->want == 5u && d.type == 6u)) return 0;   /* an ACK, or its NAK */
    c->d = d;
    return 1;
}

static int run_dhcp(UBYTE *ctr, UBYTE *last_pico) {
    const uint32_t xid = (uint32_t)ticks() * 2654435761u;
    char a[16], b[16], c[16], d[16];
    uint32_t took;
    dhcp_ctx_t x = { xid, 2u, {0} };
    size_t n = nl_dhcp_discover(payload, MAX_N, l2_mac, xid);
    printf("DHCP: DISCOVER xid %08lx\n", (unsigned long)xid);
    if (l2_ask(ctr, last_pico, payload, n, dhcp_fn, &x, 6, &took)) {
        printf("no OFFER in 6 s (frames seen %lu)\nRESULT: FAIL\n", c_l2_frames);
        return RETURN_WARN;
    }
    nl_ip_text(x.d.server, a); nl_ip_text(x.d.yiaddr, b); nl_ip_text(x.d.router, c); nl_ip_text(x.d.dns, d);
    printf("OFFER from %s: address %s router %s dns %s lease %lu s\n", a, b, c, d, (unsigned long)x.d.lease);
    const nl_dhcp_t offer = x.d;
    x.want = 5u;
    n = nl_dhcp_request(payload, MAX_N, l2_mac, xid, offer.yiaddr, offer.server);
    if (l2_ask(ctr, last_pico, payload, n, dhcp_fn, &x, 6, &took)) {
        printf("no ACK in 6 s -- the board refuses an ACK that names its own address: check its log for\n"
               "'pnet: l2 ... clash'\nRESULT: FAIL\n");
        return RETURN_WARN;
    }
    if (x.d.type == 6u) { printf("NAK from the server\nRESULT: FAIL\n"); return RETURN_WARN; }
    nl_ip_text(x.d.yiaddr, b);
    nl_ip_text(offer.router, c);
    printf("ACK: this Amiga is %s (router %s); saved as NetLoopIP / NetLoopRouter\n", b, c);
    SetVar((STRPTR)"NetLoopIP", (STRPTR)b, -1, GVF_GLOBAL_ONLY);
    SetVar((STRPTR)"NetLoopRouter", (STRPTR)c, -1, GVF_GLOBAL_ONLY);
    printf("RESULT: PASS\n");
    return RETURN_OK;
}

static int run_arp(UBYTE *ctr, UBYTE *last_pico, uint32_t me, uint32_t router, ULONG rounds) {
    arp_ctx_t a = { router, {0} };
    const size_t n = nl_arp_request(payload, l2_mac, me, router);
    char ip[16];
    nl_ip_text(router, ip);
    unsigned long ok = 0;
    for (ULONG i = 0; i < rounds; i++) {
        if (SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) { printf("*** Break\n"); break; }
        uint32_t took;
        if (l2_ask(ctr, last_pico, payload, n, arp_fn, &a, 5, &took) == 0) rtt[ok++] = took;
    }
    if (ok)
        printf("router %s is at %02x:%02x:%02x:%02x:%02x:%02x\n", ip, a.mac[0], a.mac[1], a.mac[2],
               a.mac[3], a.mac[4], a.mac[5]);
    printf("arp: %lu/%lu answered; frames seen %lu, stale headers %lu, unacknowledged %lu\n",
           ok, (unsigned long)rounds, c_l2_frames, c_l2_stale, c_l2_unacked);
    if (ok) {
        unsigned long w, t, w2, t2;
        ms(nl_percentile(rtt, (unsigned)ok, 50), &w, &t);
        ms(nl_percentile(rtt, (unsigned)ok, 95), &w2, &t2);
        printf("arp ms: median %lu.%lu p95 %lu.%lu\n", w, t, w2, t2);
    }
    const BOOL pass = ok == rounds;
    printf("RESULT: %s\n", pass ? "PASS" : "FAIL");
    return pass ? RETURN_OK : RETURN_WARN;
}

static int st_fail(const char *what) {
    printf("selftest: %s\nRESULT: FAIL\n", what);
    return RETURN_FAIL;
}

/* The codec on this CPU, with no drive: build a batch, decode it as the board does, build the
 * board's echo, put it 8 bytes and 3 bits into a read, align it and check it. */
static int selftest(void) {
    uint16_t lens[PNET_MAX_FRAMES], el[PNET_MAX_FRAMES];
    pnet_frame_ref_t refs[PNET_MAX_FRAMES];
    unsigned nf, en = 0;
    const ULONG n = 4000;
    nl_split(n, lens, &nf);
    nl_fill(7, payload, n);
    ULONG off = 0;
    for (unsigned i = 0; i < nf; i++) { refs[i].data = payload + off; refs[i].len = lens[i]; off += lens[i]; }
    const size_t w = pnet_build_to_board(wbuf, CHIP_BYTES, 5, 0xFF, refs, nf);
    pnet_hdr_t h;
    if (!w || pnet_parse_hdr_from_amiga(wbuf + 4, w - 4, &h) != PNET_OK) return st_fail("to-board header");
    if (pnet_parse_frames(wbuf + 4 + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD, echo, ECHO_BYTES,
                          el, PNET_MAX_FRAMES, &en) != PNET_OK || en != nf || memcmp(echo, payload, n))
        return st_fail("to-board frames");
    off = 0;
    for (unsigned i = 0; i < en; i++) { refs[i].data = echo + off; refs[i].len = el[i]; off += el[i]; }
    const size_t r = pnet_build_to_amiga(rbuf + 8, CHIP_BYTES - 16u, h.amiga_ctr, 0x80, 0, refs, en);
    if (!r) return st_fail("to-amiga build");
    memset(rbuf, 0xAA, 8);
    for (size_t i = r + 8u; i-- > 1u; ) rbuf[i] = (UBYTE)((rbuf[i] >> 3) | (rbuf[i - 1] << 5));
    rbuf[0] = (UBYTE)(rbuf[0] >> 3);
    const uint64_t t0 = ticks();
    const long so = pnet_find_sync(rbuf, r + 8u, SYNC_SCAN);
    if (so < 0) return st_fail("sync not found");
    const size_t valid = pnet_shift_left(rbuf, r + 8u, (size_t)so);
    const uint64_t t1 = ticks();
    pnet_hdr_t h2;
    if (pnet_parse_hdr_to_amiga(rbuf, valid, &h2, TRUE) != PNET_OK || h2.amiga_ctr != 5 || h2.pico_ctr != 0x80)
        return st_fail("to-amiga header");
    memset(echo, 0, n);
    if (pnet_parse_frames(rbuf + PNET_HDR_MFM_BYTES, h2.data_size, PNET_TO_AMIGA, echo, ECHO_BYTES,
                          el, PNET_MAX_FRAMES, &en) != PNET_OK || en != nf || memcmp(echo, payload, n))
        return st_fail("to-amiga frames");
    const uint64_t t2 = ticks();
    unsigned long a, b, c, d;
    ms(t1 - t0, &a, &b);
    ms(t2 - t1, &c, &d);
    printf("selftest: %lu B echo, align %lu.%lu ms, parse %lu.%lu ms (codec %s)\n", (unsigned long)r,
           a, b, c, d, CODEC_NAME);
    printf("selftest: asm codec against the C reference on this CPU...\n");
    const uint64_t t3 = ticks();
    const unsigned long f = nl_equiv_run(2000u, 1u, 0x5EEDu);
    ms(ticks() - t3, &a, &b);
    printf("selftest: equivalence %s (%lu.%lu ms)\n", f ? "FAILED" : "ok", a, b);
    if (f) return st_fail("asm differs from the C reference");
    {
        const char *e = nl_eth_selftest();
        if (e) return st_fail(e);
    }
    printf("RESULT: PASS\n");
    return RETURN_OK;
}

static const char *mem_kind(const void *p) {
    const ULONG t = TypeOfMem((APTR)p);
    return (t & MEMF_CHIP) ? "CHIP" : (t & MEMF_FAST) ? "FAST" : t ? "other" : "unlisted";
}

/* Each codec stage, C then asm, mean ms per call over `reps` calls (E-clock). */
static int bench(void) {
    static nl_bench_t b;
    static const uint32_t sizes[2] = { 1500u, 8000u };
    static const unsigned reps_for[2] = { 8u, 3u };
    const ULONG mfm_sz = 2u * 8000u, rle_sz = 8000u + 8000u / 127u + 8u, scr_sz = 2u * 8000u + 64u;
    int rc = RETURN_OK, local = 0;
    b.payload = payload; b.out = echo; b.wbuf = wbuf; b.track = rbuf;
    b.aligned = AllocMem(CHIP_BYTES, MEMF_CHIP | MEMF_CLEAR);
    b.mfm_in = AllocMem(mfm_sz, MEMF_ANY);
    b.rle_in = AllocMem(rle_sz, MEMF_ANY);
    b.scratch = AllocMem(scr_sz, MEMF_ANY);
    if (!b.aligned || !b.mfm_in || !b.rle_in || !b.scratch) { printf("out of memory\n"); rc = RETURN_FAIL; goto out; }
    printf("memory: code %s $%08lx  stack %s $%08lx  tables %s\n", mem_kind((const void *)bench),
           (unsigned long)(ULONG)bench, mem_kind(&local), (unsigned long)(ULONG)&local, mem_kind(pnet_mfm_tab));
    printf("memory: wbuf %s  rbuf %s  aligned %s  payload %s  echo %s  work %s\n", mem_kind(wbuf),
           mem_kind(rbuf), mem_kind(b.aligned), mem_kind(payload), mem_kind(echo), mem_kind(b.scratch));
    printf("codec in use: %s. Times: mean ms per call; x = C / asm on random.\n", CODEC_NAME);
    for (unsigned z = 0; z < 2; z++) {
        const uint32_t n = sizes[z];
        const unsigned reps = reps_for[z];
        unsigned long v[NL_BENCH_STAGES][NL_BENCH_INPUTS][2];
        BOOL differ = FALSE;
        for (unsigned k = 0; k < NL_BENCH_INPUTS; k++) {
            if (!nl_bench_prep(&b, k, n)) { printf("bench: %s N=%lu did not prepare\n", nl_bench_input_name[k],
                                                   (unsigned long)n); rc = RETURN_FAIL; goto out; }
            for (unsigned s = 0; s < NL_BENCH_STAGES; s++) {
                long res[2];
                for (unsigned i = 0; i < 2; i++) {
                    if (SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) { printf("*** Break\n"); rc = RETURN_WARN; goto out; }
                    const uint64_t t0 = ticks();
                    for (unsigned r = 0; r < reps; r++) res[i] = nl_bench_stage(&b, s, i);
                    const uint64_t t = ticks() - t0;
                    v[s][k][i] = nl_tenths(t * 10000u, (uint64_t)hz * reps);   /* 1/100 ms */
                }
                if (res[0] != res[1]) differ = TRUE;
            }
        }
        printf("N=%lu, mean ms per call over %u calls\n", (unsigned long)n, reps);
        printf("%-8s%8s%8s%8s%8s%8s%8s%7s\n", "stage", "rand C", "asm", "mixed C", "asm", "zero C", "asm", "x");
        for (unsigned s = 0; s < NL_BENCH_STAGES; s++) {
            printf("%-8s", nl_bench_stage_name[s]);
            for (unsigned k = 0; k < NL_BENCH_INPUTS; k++)
                for (unsigned i = 0; i < 2; i++)
                    printf(" %4lu.%02lu", v[s][k][i] / 100u, v[s][k][i] % 100u);
            const unsigned long x = v[s][0][1] ? nl_tenths(v[s][0][0], v[s][0][1]) : 0;
            printf(" %4lu.%lu\n", x / 10u, x % 10u);
        }
        if (differ) { printf("bench: a stage's C and asm results differ\n"); rc = RETURN_FAIL; }
    }
out:
    if (b.aligned) FreeMem(b.aligned, CHIP_BYTES);
    if (b.mfm_in) FreeMem(b.mfm_in, mfm_sz);
    if (b.rle_in) FreeMem(b.rle_in, rle_sz);
    if (b.scratch) FreeMem(b.scratch, scr_sz);
    printf("RESULT: %s\n", rc == RETURN_OK ? "PASS" : "FAIL");
    return rc;
}

static BOOL cleaned;

static void cleanup(void) {
    if (cleaned) return;
    cleaned = TRUE;
    if (td_open) {
        /* Off cylinder 77 first (final review M2): there the board releases DF1's WPROT, and a
         * head left on it lets the next disk DF1 receives read as writable before DOS's first
         * seek. Every exit comes through here, Ctrl-C (atexit) included; a failed seek changes
         * nothing the motor-off and CloseDevice below need. */
        td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(0));
        td_io(TD_MOTOR, 0, NULL, 0, 0);      /* io_Length 0: motor off */
        CloseDevice((struct IORequest *)td);
    }
    if (timer_open) CloseDevice((struct IORequest *)treq);
    if (td) DeleteIORequest((struct IORequest *)td);
    if (treq) DeleteIORequest((struct IORequest *)treq);
    if (port) DeleteMsgPort(port);
    if (wbuf) FreeMem(wbuf, CHIP_BYTES);
    if (rbuf) FreeMem(rbuf, CHIP_BYTES);
    if (payload) FreeMem(payload, MAX_N);
    if (echo) FreeMem(echo, ECHO_BYTES);
    if (rtt) FreeMem(rtt, MAX_ROUNDS * sizeof *rtt);
}

int main(void) {
    LONG args[12] = {0};
    struct RDArgs *rd = ReadArgs((STRPTR)"N/K/N,ROUNDS/K/N,READS/K/N,SELFTEST/S,BENCH/S,DIAG/S,ARP/S,DHCP/S,MAC/K,IP/K,ROUTER/K,WAIT/K/N", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"NetLoop"); return RETURN_FAIL; }
    const unsigned long n = args[0] ? (unsigned long)*(LONG *)args[0] : 64u;
    const BOOL do_arp = args[6] != 0, do_dhcp = args[7] != 0;
    char mac_s[24] = "", ip_s[16] = "", router_s[16] = "";
    const char *too_long = NULL;   /* never truncate an argument: a cut-off address would be accepted */
    if (args[8]) { if (nl_arg_fits((const char *)args[8], sizeof mac_s)) strcpy(mac_s, (const char *)args[8]); else too_long = "MAC"; }
    if (args[9]) { if (nl_arg_fits((const char *)args[9], sizeof ip_s)) strcpy(ip_s, (const char *)args[9]); else too_long = "IP"; }
    if (args[10]) { if (nl_arg_fits((const char *)args[10], sizeof router_s)) strcpy(router_s, (const char *)args[10]); else too_long = "ROUTER"; }
    (void)args[11];   /* WAIT: reserved for a later per-ask timeout */
    const unsigned long rounds = args[1] ? (unsigned long)*(LONG *)args[1] : (do_arp || do_dhcp) ? 1u : MAX_ROUNDS;
    const unsigned long reads = args[2] ? (unsigned long)*(LONG *)args[2] : 2u;
    const BOOL self = args[3] != 0, bench_only = args[4] != 0;
    diag = args[5] != 0;
    FreeArgs(rd);
    printf("NetLoop 1.2 -- PaulaNET protocol by RobSmithDev, used with permission\n");
    if (n < 1 || n > MAX_N || rounds < 1 || rounds > MAX_ROUNDS || (reads != 1 && reads != 2)) {
        printf("N=1..%lu ROUNDS=1..%lu READS=1|2\n", (unsigned long)MAX_N, (unsigned long)MAX_ROUNDS);
        return RETURN_ERROR;
    }
    int rc = RETURN_FAIL;
    atexit(cleanup);   /* a libnix Ctrl-C exit still closes the devices and frees CHIP memory */
    port = CreateMsgPort();
    td = port ? (struct IOExtTD *)CreateIORequest(port, sizeof *td) : NULL;
    treq = port ? (struct timerequest *)CreateIORequest(port, sizeof *treq) : NULL;
    wbuf = AllocMem(CHIP_BYTES, MEMF_CHIP | MEMF_CLEAR);
    rbuf = AllocMem(CHIP_BYTES, MEMF_CHIP | MEMF_CLEAR);
    payload = AllocMem(MAX_N, MEMF_ANY | MEMF_CLEAR);
    echo = AllocMem(ECHO_BYTES, MEMF_ANY | MEMF_CLEAR);
    rtt = AllocMem(MAX_ROUNDS * sizeof *rtt, MEMF_ANY | MEMF_CLEAR);
    if (!td || !treq || !wbuf || !rbuf || !payload || !echo || !rtt) { printf("out of memory\n"); goto out; }
    if (OpenDevice((STRPTR)TIMERNAME, UNIT_ECLOCK, (struct IORequest *)treq, 0)) {
        printf("no timer.device\n"); goto out;
    }
    timer_open = TRUE;
    TimerBase = treq->tr_node.io_Device;
    if (self) { rc = selftest(); goto out; }
    if (bench_only) { rc = bench(); goto out; }
    if (too_long) { printf("%s= is too long\nRESULT: FAIL\n", too_long); goto out; }
    if ((do_arp || do_dhcp) && !nl_parse_mac(mac_s, l2_mac)) {
        printf("ARP and DHCP need MAC=<the board's MAC>, as its boot log prints it\n"); goto out;
    }
    if (OpenDevice((STRPTR)TD_NAME, DF1_UNIT, (struct IORequest *)td, 0)) {
        printf("no DF1 (trackdisk.device unit 1)\n"); goto out;
    }
    td_open = TRUE;
    td_io(TD_CHANGESTATE, 0, NULL, 0, 0);
    if (td->iotd_Req.io_Actual) {
        printf("DF1 has no disk: mount a set on DF0 so DF1 gets its next disk\n"); goto out;
    }
    UBYTE ctr, last_pico;
    uint32_t took;
    if (!resync(&ctr, &last_pico, do_arp || do_dhcp))
        printf("resync: no header from the board, starting from 0xFF/0xFF\n");
    if (do_dhcp) { rc = run_dhcp(&ctr, &last_pico); goto out; }
    if (do_arp) {
        uint32_t me = 0, router = 0;
        char v[16];
        if (!ip_s[0] && GetVar((STRPTR)"NetLoopIP", (STRPTR)v, sizeof v, GVF_GLOBAL_ONLY) > 0) strcpy(ip_s, v);
        if (!router_s[0] && GetVar((STRPTR)"NetLoopRouter", (STRPTR)v, sizeof v, GVF_GLOBAL_ONLY) > 0) strcpy(router_s, v);
        if (!nl_parse_ip(ip_s, &me) || !nl_parse_ip(router_s, &router)) {
            printf("ARP needs IP= and ROUTER= (or a NetLoop DHCP lease first)\n"); goto out;
        }
        rc = run_arp(&ctr, &last_pico, me, router, rounds);
        goto out;
    }
    if (one_round(&ctr, &last_pico, n, reads, 1, &took) != 0)    /* warm-up: motor, seek; not counted */
        printf("warm-up round failed (not counted); the counted rounds follow\n");
    c_ioerr = c_nosync = c_badhdr = c_stale = c_rewrites = c_mismatch = c_failed = 0;
    memset(c_nosync_k, 0, sizeof c_nosync_k);
    memset(c_bad_k, 0, sizeof c_bad_k);
    memset(c_off_k, 0, sizeof c_off_k);
    n_late = 0;
    t_write = t_read = t_align = t_build = 0;
    printf("N=%lu ROUNDS=%lu READS=%lu%s\n", n, rounds, reads, diag ? " DIAG" : "");
    unsigned long ok = 0, done = 0;
    uint64_t total = 0;
    for (ULONG i = 0; i < rounds; i++) {
        if (SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) { printf("*** Break\n"); break; }
        const int res = one_round(&ctr, &last_pico, n, reads, i * 2654435761u + 2u, &took);
        total += took;
        done++;
        if (res == 0) rtt[ok++] = took;
        else if (res == 1) c_failed++;
    }
    unsigned long a, b, c, d, e, f, g, k;
    printf("rounds %lu/%lu ok, mismatches %lu, failed %lu\n", ok, rounds, c_mismatch, c_failed);
    printf("retries: stale %lu rewrites %lu nosync %lu badhdr %lu ioerr %lu\n",
           c_stale, c_rewrites, c_nosync, c_badhdr, c_ioerr);
    static const char *const rk_name[2] = { "hdr", "pay" };
    for (int k = 0; k < 2; k++)
        printf("%s read: nosync %lu  badhdr short %lu checksum %lu magic %lu other %lu\n", rk_name[k],
               c_nosync_k[k], c_bad_k[k][0], c_bad_k[k][1], c_bad_k[k][2], c_bad_k[k][3]);
    printf("sync byte offset, 8-byte bins:\noff ");
    for (unsigned i = 0; i + 1u < OFF_BINS; i++) printf("%4u", i * 8u);
    printf(" 128+\n");
    for (int k = 0; k < 2; k++) {
        printf("%s ", rk_name[k]);
        for (unsigned i = 0; i < OFF_BINS; i++) printf(i + 1u < OFF_BINS ? "%4lu" : " %4lu", c_off_k[k][i]);
        printf("\n");
    }
    if (diag && n_late) {
        printf("DIAG late payload syncs (byte):");
        for (unsigned i = 0; i < n_late; i++) printf(" %lu", late_off[i]);
        printf("\n");
    }
    const unsigned long kb = nl_tenths((uint64_t)n * ok * hz, total * 1024u);
    const unsigned long kb2 = nl_tenths((uint64_t)n * ok * 2u * hz, total * 1024u);
    printf("one-way %lu.%lu KB/s, both ways %lu.%lu KB/s (1 KB = 1024 B)\n", kb / 10u, kb % 10u,
           kb2 / 10u, kb2 % 10u);
    if (ok) {
        const unsigned long med = nl_percentile(rtt, (unsigned)ok, 50), p95 = nl_percentile(rtt, (unsigned)ok, 95);
        ms(med, &a, &b); ms(p95, &c, &d); ms(rtt[0], &e, &f); ms(rtt[ok - 1], &g, &k);
        printf("rtt ms: median %lu.%lu p95 %lu.%lu min %lu.%lu max %lu.%lu\n", a, b, c, d, e, f, g, k);
    }
    if (done) {
        ms(t_write / done, &a, &b); ms(t_read / done, &c, &d); ms(t_align / done, &e, &f);
        ms(t_build / done, &g, &k);
        printf("mean ms per round: build(encode) %lu.%lu write %lu.%lu read %lu.%lu align+header %lu.%lu\n",
               g, k, a, b, c, d, e, f);
    }
    const BOOL pass = ok == rounds && c_mismatch == 0 && c_failed == 0;
    printf("RESULT: %s\n", pass ? "PASS" : "FAIL");
    rc = pass ? RETURN_OK : RETURN_WARN;
out:
    cleanup();
    return rc;
}
