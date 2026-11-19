// See orig_drive.h.
#include "orig_drive.h"
#include <string.h>

volatile bool g_orig_swapped = false;

const char *orig_mode_wire(orig_mode_t m) { return m == ORIG_MODE_OFF ? "off" : "auto"; }

bool orig_mode_from_wire(const char *s, orig_mode_t *out) {
    if (!s) return false;
    if (strcmp(s, "auto") == 0) { *out = ORIG_MODE_AUTO; return true; }
    if (strcmp(s, "off") == 0)  { *out = ORIG_MODE_OFF;  return true; }
    return false;
}

orig_mode_t orig_mode_from_byte(uint8_t b) { return b == ORIG_MODE_OFF ? ORIG_MODE_OFF : ORIG_MODE_AUTO; }

orig_state_t orig_drive_decide(orig_mode_t mode, bool read_ok, uint8_t input_reg) {
    orig_state_t s = { false, false, false };
    if (!read_ok) return s;
    s.expander = true;
    s.present = (input_reg & ORIG_BIT_DET) == 0;
    s.active = s.present && mode == ORIG_MODE_AUTO;
    return s;
}

uint8_t orig_drive_output_reg(bool active) { return active ? (uint8_t)(0xFFu & ~ORIG_BIT_EN_N) : 0xFFu; }
uint8_t orig_drive_config_reg(bool active) { return active ? (uint8_t)(0xFFu & ~ORIG_BIT_EN_N) : 0xFFu; }

unsigned orig_unit_line(unsigned d) {
    const unsigned line = d == 0 ? 0u : 1u;
    return g_orig_swapped ? 1u - line : line;
}

uint8_t orig_lines_to_units(uint8_t line_mask) {
    uint8_t u = 0;
    for (unsigned d = 0; d < 2; d++)
        if (line_mask & (1u << orig_unit_line(d))) u |= (uint8_t)(1u << d);
    return u;
}

bool orig_unit_is_df0(unsigned d) { return d == 0 && !g_orig_swapped; }
