#ifndef DISPLAY_LAYOUT_H
#define DISPLAY_LAYOUT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// OLED layout model: spec 2026-10-04-oled-layouts-design.md §4-§5.
// Rule: element sizes are fixed per element (and scale), never measured from
// the text currently shown, so a layout that validates once validates always.

#define LAYOUT_FORMAT        1
#define LAYOUT_MAX_ELEMENTS  16
#define LAYOUT_BLOB_MAX      (4 + 8 * LAYOUT_MAX_ELEMENTS)   // 132
#define STATUS_MAX_CHARS     8     // "DOWNLOAD"
// The status element's opt (1.15.0): the word, or an 8x8 icon in its place.
// Any other value is a later firmware's option and draws the word, sized as
// the word, so a layout saved for a newer board still shows here. Firmware
// before 1.15.0 refuses a status opt other than 0 ("opt must be 0 for this
// element"), so the web app stores the icon only for boards on 1.15.0+.
#define STATUS_OPT_WORD      0
#define STATUS_OPT_ICON      1
#define STATUS_ICON_W        8
#define TRACK_MAX_CHARS      5     // "99/99"; the renderer clamps both numbers to 0..99
#define PCT_MAX_CHARS        4     // "100%"
#define LAYOUT_ADVANCE       6     // glyph 5 + 1 column
#define LAYOUT_LINE_H        8

typedef enum { PANEL_128x32 = 0, PANEL_128x64 = 1 } panel_t;
typedef enum { EL_STATUS = 1, EL_WIFI = 2, EL_WRITE = 3, EL_TITLE = 4,
               EL_DETAIL = 5, EL_TRACK = 6, EL_DOWNLOAD = 7, EL_LEMMING = 8,
               // 1.10.0. Firmware before it refuses a layout that lists it at
               // all ("element id: unknown"), so the web app sends it only to
               // boards on 1.10.0 or newer. Absent from both defaults: a board
               // with no custom layout, or a layout saved before it existed,
               // draws exactly what it drew before.
               EL_NFC = 9 } element_id_t;
#define EL_LAST EL_NFC

typedef struct { uint8_t id, visible, scale, x, y, w, opt; } layout_el_t;   // scale 1 or 2
typedef struct { panel_t panel; uint8_t n; layout_el_t el[LAYOUT_MAX_ELEMENTS]; } layout_t;

int  panel_height(panel_t p);                       // 32 or 64
void layout_el_size(const layout_el_t *e, int *w, int *h);  // fixed size per spec, scaled
bool layout_decode(const uint8_t *buf, size_t len, layout_t *out, char *why, size_t why_len);
int  layout_encode(const layout_t *l, uint8_t *buf, size_t cap);           // bytes or -1
const layout_t *layout_default(panel_t p);
/** The layout of the built-in screens (boot, setup, connecting, error) on
 *  panel `p`: the 128x32 default's elements, at the top of either panel.
 *  128x64's own default draws the title at 2x, ten characters a line, which
 *  cut "Setup needed" and "wifi-floppy" short (1.10.0). */
const layout_t *layout_builtin(panel_t p);
/** layout_builtin(p) with its status element drawn as the icon: the built-in
 *  screens of a board whose custom layout chose the icon (1.15.0). */
const layout_t *layout_builtin_icon(panel_t p);

#endif
