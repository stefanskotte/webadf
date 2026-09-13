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

#define DISP_W        128
#define DISP_H        32
#define DISP_PAGES    (DISP_H / 8)
#define DISP_FB_BYTES (DISP_W * DISP_PAGES)

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
     *  opinion about it -- a pencil that disagreed with the pin would be
     *  worse than no pencil. */
    bool writable;
} display_state_t;

/** Compose `s` into a framebuffer. Pure: same state, same 512 bytes. */
void display_render(const display_state_t *s, uint8_t fb[DISP_FB_BYTES]);

/**
 * Push bytes to the panel: one page, starting at column `col`, `n` bytes.
 * Returns false if the transfer failed, which stops the pump for that call
 * WITHOUT marking the bytes clean, so the next call retries them.
 */
typedef bool (*disp_blit_fn)(void *ctx, int page, int col,
                             const uint8_t *bytes, int n);

typedef struct {
    uint8_t fb[DISP_FB_BYTES];       // what should be on the glass
    uint8_t shadow[DISP_FB_BYTES];   // what we believe is on it
    disp_blit_fn blit;
    void   *ctx;
} display_t;

/** `shadow` starts as all-zero and the panel starts cleared, so the two
 *  agree at init and only genuine changes are ever sent. */
void display_init(display_t *d, disp_blit_fn blit, void *ctx);

/** Re-render into `fb`. Sends nothing; display_pump does that. */
void display_set(display_t *d, const display_state_t *s);

/**
 * Send at most `budget` bytes, then return. THE WHOLE POINT: this is called
 * from core0's 1 ms service loop, where a full 512-byte frame (~11 ms at
 * 400 kHz) would stall the floppy exactly as a flood of USB writes would.
 * Returns bytes sent; 0 means the panel is already in sync.
 */
int display_pump(display_t *d, int budget);

/** True when the panel matches the framebuffer. Test/diagnostic use. */
bool display_in_sync(const display_t *d);

#endif
