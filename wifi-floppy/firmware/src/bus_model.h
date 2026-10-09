#ifndef BUS_MODEL_H
#define BUS_MODEL_H
// Host-only model of floppy.pio's status_gate and flux_out running as one SM
// per drive on a shared PIO (spec 2026-10-08 §4 "PIO changes"). Each step of
// bus_model_run() is one PIO cycle; pin writes follow RP2350 datasheet
// §11.2.6 (highest-numbered SM wins; unwritten pins hold). Change floppy.pio's
// status_gate/flux_out only together with this model and
// test_floppy_pio_golden.c's arrays.
//
// bus_model.c is NOT in the device build (CMakeLists.txt add_executable), like
// drive_id.c: the PIO programs are what run on the board. test/run.sh compiles
// every src/*.c it does not exclude, so the host tests pick it up.
#include <stdbool.h>
#include <stdint.h>
#define BUS_MODEL_MAX 2
typedef struct {
    unsigned n;
    uint32_t sel;                    // bit k set = SEL_k asserted
    uint32_t word[BUS_MODEL_MAX];    // the shadow pushed to drive k's gate (X)
    bool     was_sel[BUS_MODEL_MAX]; // status_gate Y
    unsigned released_writes[BUS_MODEL_MAX];
    uint32_t pads;
    // flux_out
    uint32_t fifo[BUS_MODEL_MAX]; bool fifo_full[BUS_MODEL_MAX];
    uint32_t osr[BUS_MODEL_MAX]; unsigned osr_left[BUS_MODEL_MAX];
    unsigned pc[BUS_MODEL_MAX]; unsigned delay[BUS_MODEL_MAX];
    bool     rdata;
    bool     disabled[BUS_MODEL_MAX];  // SM not enabled: runs nothing, writes no pin
} bus_model_t;
void     bus_model_init(bus_model_t *m, unsigned n);
void     bus_model_set_word(bus_model_t *m, unsigned d, uint32_t w);
void     bus_model_select(bus_model_t *m, uint32_t sel_mask);
// Drive d's status_gate and flux_out SMs enabled (the default) or not
// (bus_out_drive_enable): a disabled SM executes nothing and writes no pin.
void     bus_model_set_enabled(bus_model_t *m, unsigned d, bool on);
void     bus_model_run(bus_model_t *m, unsigned cycles);
uint32_t bus_model_pads(const bus_model_t *m);
unsigned bus_model_released_writes(const bus_model_t *m, unsigned d);
void     bus_model_feed_bits(bus_model_t *m, unsigned d, uint32_t word);
unsigned bus_model_run_count_rdata_pulses(bus_model_t *m, unsigned cycles);
bool     bus_model_rdata(const bus_model_t *m);
#endif
