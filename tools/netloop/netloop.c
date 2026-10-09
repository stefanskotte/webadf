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
 *   NetLoop [N=<bytes>] [ROUNDS=<n>] [READS=1|2] [SELFTEST]
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

static const char vers[] __attribute__((used)) =
    "$VER: NetLoop 1.0 (09.10.2026) PaulaNET protocol by RobSmithDev, used with permission";

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

/* One INDEXSYNC read of `len` bytes from side 1: aligned, header decoded. 0 = usable. */
static int read_once(ULONG len, pnet_hdr_t *h, BOOL with_payload, size_t *valid) {
    const uint64_t t0 = ticks();
    if (td_io(ETD_RAWREAD, IOTDF_INDEXSYNC, rbuf, len, PNET_TRACK_OUT)) { c_ioerr++; return 1; }
    const uint64_t t1 = ticks();
    t_read += t1 - t0;
    const long off = pnet_find_sync(rbuf, len, SYNC_SCAN);
    if (off < 0) { c_nosync++; return 1; }
    size_t span = with_payload ? len : (size_t)(off >> 3) + PNET_HDR_MFM_BYTES + 1u;
    if (span > len) span = len;
    *valid = pnet_shift_left(rbuf, span, (size_t)off);
    const int bad = pnet_parse_hdr_to_amiga(rbuf, *valid, h, with_payload) != PNET_OK;
    t_align += ticks() - t1;
    if (bad) { c_badhdr++; return 1; }
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
    if (memcmp(echo, payload, n) != 0) { c_mismatch++; return 2; }
    return 0;
}

/* Up to three tries at reading this round's echo. 1 = none answered. */
static int read_echo(UBYTE ctr, UBYTE last_pico, const uint16_t *lens, unsigned nf, ULONG n,
                     ULONG reads, pnet_hdr_t *h) {
    for (int r = 0; r < 3; r++) {
        size_t valid;
        ULONG len;
        if (reads == 2) {
            if (read_once(HDR_READ, h, FALSE, &valid)) continue;
            if (!nl_echo_answers(h->amiga_ctr, h->pico_ctr, ctr, last_pico)) { c_stale++; continue; }
            td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(PNET_TRACK_IN));   /* as PaulaNET's driver does */
            len = (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h->data_size + 64u + 1u) & ~1ul;
        } else {
            len = ((ULONG)pnet_to_amiga_bound(lens, nf) - PNET_TRAIL_BYTES + 32u + 1u) & ~1ul;
        }
        if (len > CHIP_BYTES) len = CHIP_BYTES;
        if (read_once(len, h, TRUE, &valid)) continue;
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
static BOOL resync(UBYTE *ctr, UBYTE *last_pico) {
    pnet_hdr_t h;
    size_t valid;
    *ctr = 0xFFu;
    *last_pico = 0xFFu;
    td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(PNET_TRACK_IN));   /* onto cylinder 77: WPROT releases */
    if (read_once(HDR_READ, &h, FALSE, &valid) == 0) {
        *ctr = nl_start_ctr(TRUE, h.amiga_ctr);
        *last_pico = h.pico_ctr;
        return TRUE;
    }
    return FALSE;
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
    printf("selftest: %lu B echo, align %lu.%lu ms, parse %lu.%lu ms\n", (unsigned long)r, a, b, c, d);
    printf("RESULT: PASS\n");
    return RETURN_OK;
}

static BOOL cleaned;

static void cleanup(void) {
    if (cleaned) return;
    cleaned = TRUE;
    if (td_open) {
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
    LONG args[4] = {0, 0, 0, 0};
    struct RDArgs *rd = ReadArgs((STRPTR)"N/K/N,ROUNDS/K/N,READS/K/N,SELFTEST/S", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"NetLoop"); return RETURN_FAIL; }
    const unsigned long n = args[0] ? (unsigned long)*(LONG *)args[0] : 64u;
    const unsigned long rounds = args[1] ? (unsigned long)*(LONG *)args[1] : MAX_ROUNDS;
    const unsigned long reads = args[2] ? (unsigned long)*(LONG *)args[2] : 2u;
    const BOOL self = args[3] != 0;
    FreeArgs(rd);
    printf("NetLoop 1.0 -- PaulaNET protocol by RobSmithDev, used with permission\n");
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
    if (!resync(&ctr, &last_pico))
        printf("resync: no header from the board, starting from 0xFF/0xFF\n");
    if (one_round(&ctr, &last_pico, n, reads, 1, &took) != 0)    /* warm-up: motor, seek; not counted */
        printf("warm-up round failed (not counted); the counted rounds follow\n");
    c_ioerr = c_nosync = c_badhdr = c_stale = c_rewrites = c_mismatch = c_failed = 0;
    t_write = t_read = t_align = t_build = 0;
    printf("N=%lu ROUNDS=%lu READS=%lu\n", n, rounds, reads);
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
