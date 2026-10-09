#ifndef DISPLAY_H
#define DISPLAY_H
// What the OLED shows, as pure C: no pico-sdk, no lwIP, no I2C.
//
// RULE, the same one device_client.h states and for the same reason: this
// file and display.c may include only C standard headers. Everything that
// touches the panel arrives through the blit function pointer below. That is
// what lets the whole layout -- glyphs, truncation, the track counter's
// formatting, which bytes are considered dirty -- be tested on the host,
// where a wrong pixel is a failing assertion instead of a person squinting at
// a 0.91" panel. The four rounds of "count the lines" that preceded this file
// are the argument for it.
#include <stdint.h>
#include <stdbool.h>

#include "display_layout.h"
#define DISP_W       128
#define DISP_H_MAX   64
#define DISP_FB_MAX  (DISP_W * DISP_H_MAX / 8)    // 1024: room for a 128x64 panel

// Long enough for two rendered lines of 21 characters. Titles longer than
// this are truncated with an ellipsis rather than wrapped to a third line --
// there is no third line, the bottom one belongs to the disk/detail field.
#define DISP_TITLE_MAX  42
#define DISP_DETAIL_MAX 21

typedef enum {
    DS_BOOT,       // powered, nothing decided yet
    DS_PORTAL,     // captive portal AP is up, waiting for a human
    DS_WIFI,       // associating
    DS_READY,      // online, nothing mounted
    DS_DOWNLOAD,   // fetching an image (pct is meaningful)
    DS_VERIFY,     // digest check after the fetch
    DS_LOADED,     // a disk is mounted and servable
    DS_ERROR,      // backoff / halted / no route
} disp_status_t;

typedef enum { DISP_SYNC_SYNCED = 0, DISP_SYNC_PENDING, DISP_SYNC_OFFLINE } disp_sync_t;

/** The tag reader, for the NFC element (1.10.0). ABSENT is zero so a state
 *  nobody filled in claims no reader rather than one. */
typedef enum { DISP_NFC_ABSENT = 0, DISP_NFC_PRESENT, DISP_NFC_ARMED } disp_nfc_t;

typedef struct {
    disp_status_t status;
    // 0..3 arcs, or -1 for "no radio at all" which draws the bare dot. This
    // is a signal-strength glyph, so it is NOT a proxy for "the server is
    // reachable" -- DS_ERROR with three bars is a real and useful display.
    int  bars;
    char title[DISP_TITLE_MAX + 1];
    char detail[DISP_DETAIL_MAX + 1];
    // The track counter, shown only while a disk is mounted: with nothing
    // mounted `cyl` is whatever the head was last stepped to, which is a
    // number about no disk and worse than a blank.
    bool show_track;
    int  cyl;        // 0..max_cyl
    int  max_cyl;    // 79 for a standard Amiga DD disk
    int  pct;        // download percent, or -1 to omit
    // Walk-cycle frame for the lemming. Part of the STATE, not a timer read
    // inside the renderer, so display_render stays pure and a given frame is
    // reproducible in a test. The caller advances it; see main.c.
    int  tick;
    /** The mounted disk can be WRITTEN to. Shown because it is the one state
     *  on this panel that changes what the Amiga is allowed to do to your
     *  disk, and the operator asked to be able to see it from across the
     *  room. Driven by the same value that drives WPROT, never a second
     *  opinion about it -- a cloud that disagreed with the pin would be
     *  worse than no cloud. */
    bool writable;
    disp_sync_t sync;
    /** Drawn only by a layout that lists EL_NFC (none of the defaults do).
     *  PRESENT: the reader answers. ABSENT: it does not, or has not been
     *  checked yet -- struck through, never blank, as the wifi glyph does
     *  for "no radio". ARMED: a tag write waits for a tap (inverted). Last
     *  in the struct so every earlier offset is unchanged for display.wasm. */
    disp_nfc_t nfc;
} display_state_t;

/** Compose `s` into a framebuffer by drawing each visible element of `l`, in
 *  list order, at its position and scale. Renders into the first
 *  panel_height(l->panel)/8 pages and zeroes the rest. Pure: same state and
 *  layout, same 1024 bytes. */
void display_render(const display_state_t *s, const layout_t *l, uint8_t fb[DISP_FB_MAX]);

/** READY, DOWNLOAD, VERIFY and LOADED: the states a custom layout draws. */
bool display_state_is_running(disp_status_t st);

/** The layout to draw `s` with: `custom` in a running state, otherwise
 *  layout_builtin(custom's panel) -- boot, portal, connecting and error
 *  screens never depend on a user's layout. */
const layout_t *display_layout_for(const display_state_t *s, const layout_t *custom);

/**
 * Push bytes to the panel: one page, starting at column `col`, `n` bytes.
 * Returns false if the transfer failed, which stops the pump for that call
 * WITHOUT marking the bytes clean, so the next call retries them.
 */
typedef bool (*disp_blit_fn)(void *ctx, int page, int col,
                             const uint8_t *bytes, int n);

typedef struct {
    uint8_t fb[DISP_FB_MAX];         // what should be on the glass
    uint8_t shadow[DISP_FB_MAX];     // what we believe is on it
    panel_t panel;                   // how many pages the pump sends
    const layout_t *layout;          // the custom layout for running states
    int resend_page, resend_col;     // -1: none; else next byte of a full resend after a panel change
    disp_blit_fn blit;
    void   *ctx;
} display_t;

/** `shadow` starts as all-zero and the panel starts cleared, so the two
 *  agree at init and only genuine changes are ever sent. */
void display_init(display_t *d, disp_blit_fn blit, void *ctx);

/** Re-render into `fb` with display_layout_for(s, d->layout). Sends
 *  nothing; display_pump does that. */
void display_set(display_t *d, const display_state_t *s);

/** Use `l` for running states from the next display_set on. `l` must outlive
 *  its use; the pointer is stored, not copied. Refuses (returns false, layout
 *  unchanged) when l->panel differs from d->panel. */
bool display_set_layout(display_t *d, const layout_t *l);

/** Switch panel type: layout back to layout_default(p), fb and shadow cleared,
 *  and the pump resends EVERY byte of every page of the new panel (even 0xFF
 *  ones). The caller re-runs ssd1306_init for the new type first; the caller
 *  may then display_set_layout a custom layout for p. */
void display_set_panel(display_t *d, panel_t p);

/**
 * Send at most `budget` bytes, then return. THE WHOLE POINT: this is called
 * from core0's 1 ms service loop, where a full 1024-byte frame (~22 ms at
 * 400 kHz; 512 bytes on a 128x32) would stall the floppy exactly as a flood of USB writes would.
 * Returns bytes sent; 0 means the panel is already in sync.
 */
int display_pump(display_t *d, int budget);

/** True when the panel matches the framebuffer. Test/diagnostic use. */
bool display_in_sync(const display_t *d);

#endif
