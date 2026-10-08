#ifndef DSKCHG_H
#define DSKCHG_H
#include <stdbool.h>
#include <stdint.h>
// Disk-change (/CHNG) and ready (/RDY) state, one per drive (0 = DF0,
// 1 = DF1; bus_out.h WF_DRIVES). Pins go through bus_out_set_drive(), which
// ignores a drive that was not configured, so drive 1's state is kept but
// never reaches the bus until bus_out_init configured it.

/** Both drives: no image, /CHNG asserted, motor off. */
void dskchg_init(void);
/** How many drives dskchg_poll() serves (1 .. WF_DRIVES; default 1). */
void dskchg_set_drives(unsigned n);
void dskchg_image_inserted_d(unsigned d);
void dskchg_image_ejected_d(unsigned d);
/** From the STEP ISR, for a step drive d acted on. */
void dskchg_on_step_d(unsigned d);
void dskchg_on_motor_d(unsigned d, bool on);
/** Every configured drive. */
void dskchg_poll(void);
bool dskchg_image_in_d(unsigned d);
/** The Amiga has drive d's motor on (latched on its select). */
bool dskchg_motor_on_d(unsigned d);
/** ms since boot when drive d's motor last came on (meaningful while it is on). */
uint32_t dskchg_motor_on_ms_d(unsigned d);

// Drive 0 (DF0): every caller from before the second drive.
static inline void dskchg_image_inserted(void) { dskchg_image_inserted_d(0); }
static inline void dskchg_image_ejected(void)  { dskchg_image_ejected_d(0); }
static inline void dskchg_on_step(void)        { dskchg_on_step_d(0); }
static inline void dskchg_on_motor(bool on)    { dskchg_on_motor_d(0, on); }
static inline bool dskchg_image_in(void)       { return dskchg_image_in_d(0); }
/** The Amiga has the motor on (latched on SEL0). */
static inline bool dskchg_motor_on(void)       { return dskchg_motor_on_d(0); }
/** ms since boot when the motor last came on (meaningful while it is on). */
static inline uint32_t dskchg_motor_on_ms(void) { return dskchg_motor_on_ms_d(0); }
#endif
