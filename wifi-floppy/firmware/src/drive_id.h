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
//  * Only SEL0 is looked at: a select of another drive changes nothing, and
//    RDY is released whenever SEL0 is (the SEL0 gating rule, HANDOFF 4e), so
//    a real drive on DF1 is untouched.
//  * MTR is latched on each SEL0 fall, as a real drive (and sel_mtr) does.
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
// The CPU changes the ID (bus_out_drive_id_set_hd rewrites the two loads):
// taken at the next load -- the next reset, or the 32-bit repeat.
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

// The instruction bus_out.c writes at drive_id's reset_load and repeat_load:
// `mov osr, y` for HD (Y holds DRIVE_ID_HD from init), `mov osr, ~null` for
// DD's all ones, or `mov osr, null` for NONE's all zeros. Built from the MOV
// fields -- opcode 101 [15:13], destination OSR 111 [7:5], op [4:3] (00 none,
// 01 = invert), source [2:0] (Y 010, NULL 011) -- and NEVER with
// pio_encode_mov(pio_osr, ...): in pico-sdk 2.3.0 release builds that returns
// `mov pindirs, ...` (pio_osr == pio_exec, remapped twice), which turned RDY's
// output off on every HD reload (1.4.0, HANDOFF §3an). Pinned by
// test_drive_id_pio.c.
static inline uint16_t drive_id_load_kind(drive_id_kind_t k) {
    const unsigned op  = k == DRIVE_ID_KIND_DD ? 1u : 0u;      // invert for DD's all-ones
    const unsigned src = k == DRIVE_ID_KIND_HD ? 2u : 3u;      // Y (HD word) / NULL
    return (uint16_t)((0x5u << 13) | (0x7u << 5) | (op << 3) | src);
}
static inline uint16_t drive_id_load(bool hd) {
    return drive_id_load_kind(hd ? DRIVE_ID_KIND_HD : DRIVE_ID_KIND_DD);
}

#endif
