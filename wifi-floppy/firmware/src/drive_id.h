#ifndef DRIVE_ID_H
#define DRIVE_ID_H
// ---------------------------------------------------------------------------
// Amiga drive-ID answer: the pure half (HD spec 2026-09-26 §5.4).
//
// The timing lives in PIO (floppy.pio: drive_id, answering on RDY from pio0).
// What that program DOES, select by select, is modelled here so the protocol
// is host-tested; each model line names the instruction it stands for, and
// the program is changed only together with this model.
//
//  * Only this drive's own select is looked at (the SM's in_base, `wait pin 0`:
//    SEL0 for DF0, SEL1 for the board's DF1): a select of another drive
//    changes nothing, and RDY is released whenever this select is (the gating
//    rule, HANDOFF 4e), so a real drive on another select is untouched.
//  * MTR is latched on each fall of this drive's select, as a real drive (and
//    sel_mtr) does.
//  * Motor latched ON: RDY is the CPU's level (dskchg: spun up + disk in).
//  * Motor latched OFF: the FIRST such select after a motor-on one (or after
//    power-up) loads the ID and answers bit 31 at once; every motor-off
//    select after it answers the next bit, MSB first, 1 = RDY asserted. A
//    motor-on select resets: the next motor-off select starts at bit 31
//    again. After 32 the pattern repeats seamlessly.
//
// Why that phase: the amiga-hddlw PAL (github.com/schlae/amiga-hddlw,
// pal/amiga-hddlw.pld), a real HD drive's logic: a motor-on select resets the
// ID, and RDY is asserted on the first motor-off select after it (DD: on
// every one; HD: alternately, starting asserted). Verified on the bench
// 2026-09-27 (HANDOFF §3an, firmware 1.4.1). 1.4.0's "the reset select
// carries no bit" was wrong.
//
// Polarity: "asserted" is GPIO 12 HIGH, which through the BSS138 pulls /RDY
// LOW (floppy_io.h, bus_gate.c); the Amiga counts /RDY low as a 1 bit, so a
// DD drive (RDY asserted on every ID select) reads 0xFFFFFFFF.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>

#define DRIVE_ID_DD    0xFFFFFFFFu   // 3.5" DD
#define DRIVE_ID_HD    0xAAAAAAAAu   // 3.5" HD (with HD media in)

typedef struct {
    uint32_t id;           // what the next load takes
    uint32_t shifter;      // OSR
    unsigned bits_left;    // 32 - OSR's shift count
    bool     motor_on;     // latched at the last SEL0 fall; true at power-up
    bool     selected;
    bool     level;        // the CPU's RDY level (X)
    bool     rdy;          // RDY asserted (GPIO high) right now
} drive_id_model_t;

void drive_id_model_init(drive_id_model_t *m, uint32_t id);
// The CPU changes the ID (bus_out_drive_id_set writes the SM's Y, which both
// loads read -- drive_id_y_sequence): taken at the next load -- the next
// reset, or the 32-bit repeat.
void drive_id_model_set_id(drive_id_model_t *m, uint32_t id);
// SEL0 falls with MTR as given (true = motor requested, bus line low).
void drive_id_model_select(drive_id_model_t *m, bool mtr_on);
void drive_id_model_deselect(drive_id_model_t *m);
void drive_id_model_level(drive_id_model_t *m, bool assert);
// The level the program drives on GPIO 12: true = high = /RDY low on the bus.
bool drive_id_model_rdy_gpio(const drive_id_model_t *m);

// The ID the board answers: HD while an HD (ADF_HD) disk is mounted; DD for a
// DD disk, an HFE, or no disk (spec §5.4). Inline, because the device build
// uses it for its log lines but does not link the model above (drive_id.c is
// host-test-only: the PIO program is what runs on the board).
static inline uint32_t drive_id_for(bool hd_mounted) {
    return hd_mounted ? DRIVE_ID_HD : DRIVE_ID_DD;
}

// What a drive answers to Kickstart's drive-ID read (spec 2026-10-08 §2).
// NONE answers 0x00000000 = "no drive": DF1 while off or parked.
typedef enum { DRIVE_ID_KIND_NONE = 0, DRIVE_ID_KIND_DD, DRIVE_ID_KIND_HD } drive_id_kind_t;

// The word at drive_id's reset_load and repeat_load, for each kind, as
// bus_out.c USED to write it into instr_mem (until the DF1 work, Task 8):
// `mov osr, y` (HD), `mov osr, ~null` (DD's all ones), `mov osr, null`
// (NONE's all zeros). Nothing writes instr_mem now -- the program is shared by
// one SM per drive, so both loads stay `mov osr, y` and each SM's Y holds its
// own ID word (drive_id_y_sequence below). Kept because it documents the
// encodings and test_drive_id_pio.c pins them: the source's `mov osr, y` IS
// drive_id_load_kind(HD). Built from the MOV fields -- opcode 101 [15:13],
// destination OSR 111 [7:5], op [4:3] (00 none, 01 = invert), source [2:0]
// (Y 010, NULL 011) -- and NEVER with pio_encode_mov(pio_osr, ...): in
// pico-sdk 2.3.0 release builds that returns `mov pindirs, ...` (pio_osr ==
// pio_exec, remapped twice), which turned RDY's output off on every HD reload
// (1.4.0, HANDOFF §3an).
static inline uint16_t drive_id_load_kind(drive_id_kind_t k) {
    const unsigned op  = k == DRIVE_ID_KIND_DD ? 1u : 0u;      // invert for DD's all-ones
    const unsigned src = k == DRIVE_ID_KIND_HD ? 2u : 3u;      // Y (HD word) / NULL
    return (uint16_t)((0x5u << 13) | (0x7u << 5) | (op << 3) | src);
}
static inline uint16_t drive_id_load(bool hd) {
    return drive_id_load_kind(hd ? DRIVE_ID_KIND_HD : DRIVE_ID_KIND_DD);
}

// The ID word each kind answers: what Y must hold.
static inline uint32_t drive_id_word(drive_id_kind_t k) {
    return k == DRIVE_ID_KIND_HD ? DRIVE_ID_HD : k == DRIVE_ID_KIND_DD ? DRIVE_ID_DD : 0u;
}

// ---------------------------------------------------------------------------
// Writing an SM's Y while it runs, WITHOUT touching its OSR.
//
// The OSR is the answer in progress. An exec'd `pull` would replace it
// mid-answer (a torn ID), and its shift count cannot be restored, so the
// FIFO -> OSR -> Y path is used only at init, before the machine runs. After
// that, Y is written by exec'd instructions that touch only Y and the ISR,
// which drive_id never uses (no `in`, no `push`, no `mov isr` -- pinned by
// test_drive_id_pio.c):
//   NONE: mov y, null                                       (1 exec)
//   DD:   mov y, ~null                                      (1 exec)
//   HD:   mov isr, null; 32 x { in null, 1; mov isr, ~isr }; in null, 1;
//         mov y, isr                                        (67 execs)
// Y changes only at the LAST exec, in one instruction, so a load (reset_load
// or repeat_load) that runs between any two execs takes the old word or the
// new one, never a mix: an exec at any PC is safe, no guard, no deferral, and
// the change still takes effect at the next load (the repeat included) --
// test_drive_id.c's an_id_change_waits_for_the_next_answer.
//
// HD's build is x -> ~(x << 1) 32 times from 0 (0x55555555), then one more
// shift: 0xAAAAAAAA. It needs IN shifting LEFT (SHIFTCTRL_IN_SHIFTDIR = 0,
// set by drive_id_program_init); shifting right the same words end at
// 0x55555555 -- pinned by test_drive_id_pio.c. Only `in null` and `mov` with
// ISR as a plain source are used: the datasheet does not say whether `in isr,
// n` takes ISR's bits before or after the shift, so a shorter doubling
// sequence built on it was not used.
//
// Exec semantics (RP2350 datasheet §11.5.7, "Forced and EXEC'd
// instructions", pp. 913-914): an instruction written to SMx_INSTR is
// decoded and executed at once, instead of the one the PC would fetch; the
// PC does not advance, so a machine stalled on a WAIT resumes that WAIT
// afterwards. Delay cycles and the clock divider are
// ignored. Only an exec'd instruction that itself stalls is latched
// (EXECCTRL_EXEC_STALLED); `mov` and `in` with autopush off never stall, so
// none is latched and a plain pio_sm_exec suffices.
//
// Words built from the fields (MOV: 101 [15:13], dest [7:5] Y 010 / ISR 110,
// op [4:3] 01 = invert, src [2:0] NULL 011 / ISR 110; IN: 010 [15:13], src
// [7:5] NULL 011, count [4:0]) -- checked against pioasm, and never via
// pio_encode_mov (see above).
// ---------------------------------------------------------------------------
#define DRIVE_ID_Y_SEQ_MAX 67u
#define DRIVE_ID_MOV_Y_NULL     0xa043u   // mov y, null
#define DRIVE_ID_MOV_Y_NOT_NULL 0xa04bu   // mov y, ~null
#define DRIVE_ID_MOV_ISR_NULL   0xa0c3u   // mov isr, null
#define DRIVE_ID_IN_NULL_1      0x4061u   // in null, 1
#define DRIVE_ID_MOV_ISR_NOT_ISR 0xa0ceu  // mov isr, ~isr
#define DRIVE_ID_MOV_Y_ISR      0xa046u   // mov y, isr

static inline uint16_t drive_id_mov_word(unsigned dest, unsigned op, unsigned src) {
    return (uint16_t)((0x5u << 13) | (dest << 5) | (op << 3) | src);
}
static inline uint16_t drive_id_in_word(unsigned src, unsigned count) {
    return (uint16_t)((0x2u << 13) | (src << 5) | (count & 0x1fu));
}

// Fills seq with the instructions that make Y = drive_id_word(k); returns how
// many (1..DRIVE_ID_Y_SEQ_MAX).
static inline unsigned drive_id_y_sequence(drive_id_kind_t k, uint16_t seq[DRIVE_ID_Y_SEQ_MAX]) {
    enum { D_Y = 2, D_ISR = 6, S_NULL = 3, S_ISR = 6, OP_NONE = 0, OP_INV = 1 };
    if (k == DRIVE_ID_KIND_NONE) { seq[0] = drive_id_mov_word(D_Y, OP_NONE, S_NULL); return 1; }
    if (k == DRIVE_ID_KIND_DD)   { seq[0] = drive_id_mov_word(D_Y, OP_INV,  S_NULL); return 1; }
    unsigned n = 0;
    seq[n++] = drive_id_mov_word(D_ISR, OP_NONE, S_NULL);
    for (unsigned i = 0; i < 32; i++) {
        seq[n++] = drive_id_in_word(S_NULL, 1);
        seq[n++] = drive_id_mov_word(D_ISR, OP_INV, S_ISR);
    }
    seq[n++] = drive_id_in_word(S_NULL, 1);
    seq[n++] = drive_id_mov_word(D_Y, OP_NONE, S_ISR);
    return n;
}

#endif
