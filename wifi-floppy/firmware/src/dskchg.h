#ifndef DSKCHG_H
#define DSKCHG_H
#include <stdbool.h>
#include <stdint.h>
void dskchg_init(void);
void dskchg_image_inserted(void);
void dskchg_image_ejected(void);
void dskchg_on_step(void);
void dskchg_on_motor(bool on);
void dskchg_on_sel_edge(void);
void dskchg_poll(void);
bool dskchg_image_in(void);
// Diagnostic counters: SEL0 falling edges and motor-on edges the GPIO
// interrupt actually saw, and the ID bits still unsent.
void dskchg_id_stats(uint32_t *sel, uint32_t *motor_on, int *id_bits_left);
#endif
