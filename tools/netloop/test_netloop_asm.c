/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/*
 * test_netloop_asm: an Amiga executable that build.sh runs under vamos (an emulated 68000).
 * Implemented from the protocol's description; none of RobSmithDev's code is in this program.
 *
 *   test_netloop_asm                     the full asm-vs-C equivalence run; RESULT: PASS/FAIL
 *   test_netloop_asm ODD                 each asm routine at every alignment, for vamos -t
 *   test_netloop_asm CYCLES s i k n r    run bench stage s (impl i: 0 C, 1 asm) on input k with
 *                                        n bytes, r times; cycles.sh diffs vamos' cycle counts
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <exec/memory.h>
#include <proto/exec.h>
#include "pnet_asm.h"
#include "netloop_equiv.h"
#include "netloop_bench.h"

static int cycles(int argc, char **argv) {
    if (argc < 7) { printf("CYCLES stage impl input n reps\n"); return 20; }
    const unsigned stage = (unsigned)atoi(argv[2]), impl = (unsigned)atoi(argv[3]);
    const unsigned kind = (unsigned)atoi(argv[4]);
    const uint32_t n = (uint32_t)atol(argv[5]);
    const long reps = atol(argv[6]);
    static nl_bench_t b;
    b.payload = malloc(n); b.mfm_in = malloc(2u * n); b.rle_in = malloc(n + n / 127u + 8u);
    b.scratch = malloc(2u * n + 64u); b.out = malloc(n + 64u);
    b.wbuf = malloc(NL_BENCH_TRACK); b.track = malloc(NL_BENCH_TRACK); b.aligned = malloc(NL_BENCH_TRACK);
    if (!b.payload || !b.mfm_in || !b.rle_in || !b.scratch || !b.out || !b.wbuf || !b.track || !b.aligned ||
        stage >= NL_BENCH_STAGES || kind >= NL_BENCH_INPUTS || !nl_bench_prep(&b, kind, n)) {
        printf("cycles: setup failed\n");
        return 20;
    }
    long v = 0;
    for (long r = 0; r < reps; r++) v += nl_bench_stage(&b, stage, impl);
    printf("cycles: stage %u impl %u input %u n %lu reps %ld -> %ld\n", stage, impl, kind,
           (unsigned long)n, reps, v);
    return 0;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "CYCLES") == 0) return cycles(argc, argv);
    if (argc > 1 && strcmp(argv[1], "ODD") == 0) {
        printf("oddcheck: %lu cases\nRESULT: PASS\n", nl_oddcheck_run());
        return 0;
    }
    printf("test_netloop_asm: the 68000 asm codec against the C reference\n");
    const unsigned long seed = argc > 1 ? strtoul(argv[1], NULL, 0) : 1u;
    unsigned long f = nl_equiv_run(70000u, 64u, seed);
    /* The largest free block ends at the top of vamos' RAM (build.sh gives it -m 8192): inputs
     * placed against its end fault on any read past them. */
    const ULONG room = AvailMem(MEMF_ANY | MEMF_LARGEST);
    uint8_t *blk = room ? AllocMem(room, MEMF_ANY) : NULL;
    if (!blk || (ULONG)blk + room != 8192ul * 1024ul) {
        printf("  overread     the free block does not end at the top of RAM\n");
        f++;
    } else {
        const unsigned long k = nl_overread_run(blk + room, room, seed);
        printf("  %-12s %7lu cases  %s\n", "overread", k, k ? "ok" : "FAIL");
        if (!k) f++;
    }
    printf("RESULT: %s\n", f ? "FAIL" : "PASS");
    return f ? 10 : 0;
}
