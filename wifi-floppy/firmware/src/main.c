// ---------------------------------------------------------------------------
// WiFi floppy emulator — Pico 2 W main.
// Core 0: floppy bus real-time (STEP/SEL ISRs, DMA feed, INDEX pulse).
// Core 1: WiFi + track streaming from the ADF webservice.
// ---------------------------------------------------------------------------
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "net_radio.h"
#include "poll_wake.h"
#include "pico/flash.h"
#include "pico/time.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/irq.h"
#include "floppy.pio.h"
#include "floppy_io.h"
#include "dskchg.h"
#include "bus_gate.h"
#include "bus_out.h"
#include "drive_id.h"
#include "drive_store.h"
#include "df1_live.h"
#include "track_cache.h"
#include "adf_mfm.h"
#include "psram_image.h"
#include "image_loader.h"
#include "transport.h"
#include "device_client.h"
#include "tls_mem.h"           // mbedTLS allocation counters (fw/heap lines)
#include "token_store.h"
#include "sntp_time.h"
#include "provisioning.h"
#include "config_store.h"
#include "override_store.h"    // the server override (1.13.0): where this boot talks to
#include "serial_cmd.h"        //   and the "wf server" console that changes it
#include "portal_net.h"
#include "lwip/netif.h"   // default_route_str(): netif_default, see portal_stop()
#include <stdio.h>
#include "wf_log.h"
#include "activity_led.h"
#include "i2c_probe.h"
#include "ssd1306.h"
#include "display.h"
#include "display_layout.h"
#include "display_store.h"
#include "nfc_reader.h"
#include "nfc_bus_i2c.h"
#include "nfc_handoff.h"
#include "nfc_ui.h"
// Generated at BUILD time by cmake/gen_version_header.cmake, so the string
// always matches the commit this image was compiled from.
#include "wifi_floppy_version.h"
#include "flux_capture.h"
#include "flux_bits.h"
#include "mfm.h"
#include "write_back.h"
#include "reinsert.h"
#include "led_activity.h"
#include "swap_gate.h"
#include "swap_phase.h"
#include "bus_power.h"
#include "uploader.h"
#include "fw_rom.h"
#include "fw_state.h"
#include "fw_trial.h"
#include "fw_update.h"       // fwu_*, and through it fw_offer/fw_verify/fw_stage/fw_apply
#include "hardware/psram.h"  // psram_check_address, for g_fw_stage below
#include "pico/rand.h"
#include "hardware/sync.h"   // __dmb(), for the display seqlock below
#include <string.h>
#include <stddef.h>          // ptrdiff_t, for __wrap__sbrk() below
#if WF_PNET_LOOP
#include "pnet_frame.h"      // PaulaNET loopback TEST build: the cylinder-77 wire format
#include "pnet_loop.h"       //   and its decisions
#if WF_PNET_L2
#include "pnet_link.h"       // PaulaNET Phase 1: counters for real frames
#include "pnet_bridge.h"     //   the rings and core1's radio side
#include "pnet_status.h"     //   Phase 2: cylinder 76's status track
#include "pnet_lz4.h"        //   1.16.0: LZ4 both ways (spec 2026-10-18)
#include "pnet_pack.h"       //   ...board -> Amiga packing
#include "amiga_send.h"      // Phase 4: files sent to Receive on the Amiga
#include "amiga_tcp.h"       //   its lwIP and HTTPS ops
#endif
#endif

#if WF_PNET_L2
// PaulaNET Phase 4's queue text and chunk buffers (22 KB): in PSRAM, not SRAM, where they would come out of the heap
// TLS allocates from (1.13.0's heap low-water was 28,672). Uninitialized: as_init and the fetches fill them.
static __uninitialized_psram("sendq") char g_send_queue_buf[AS_QUEUE_BYTES + 1];
static __uninitialized_psram("sendc") uint8_t g_send_chunk_buf[AS_CHUNK_BYTES];
#endif

// transport_tls.c is device-only (no host test exercises it, unlike every
// other file this task wires in), so it has no shared header of its own --
// see CMakeLists.txt's -Wl,-u,tls_transport comment for how it stays
// linked in regardless of whether anything referenced it yet. Declaring
// the one entry point here, now that this file is that "anything".
transport_t *tls_transport(void);
// Same file, same reason it has no header. Releases a kept TLS connection
// once it has sat idle past the point tls_connect() would reuse it -- the
// transport owns both the "when did it go idle" stamp and the cap, so this
// asks it rather than inferring either here. Called once per pass of core1's
// two waiting loops; see release_kept_connection() below for the other,
// unconditional half.
bool tls_release_if_unreusable(void);
// Same file again. The server override's "tls noverify" (1.13.0): set once
// at boot, below, before core1 opens any connection.
void tls_set_noverify(bool on);

// ---------------------------------------------------------------- display
//
// WHERE THIS RUNS, and why it is not the obvious answer.
//
// Core1 owns the network, so it is core1 that knows DOWNLOAD and LOADED and
// the disk's name -- which makes "render on core1" the first idea anyone has,
// including me. It is wrong: core1 blocks for tens of seconds inside dc_step's
// long poll, and the TRACK COUNTER would freeze mid-seek for exactly that
// long. The counter is core0 state (cur_cyl, set by the STEP ISR), so core0 is
// what must drive the panel.
//
// But core0 cannot afford a frame. Its service loop turns over every 1 ms and
// a full 128x32 frame is 512 bytes -- ~11 ms at 400 kHz -- which would stall
// the floppy exactly as the flood of USB writes did on 2026-09-10. So:
//
//   * the framebuffer lives in RAM and is composed by display.c, which is
//     pure CPU work and pure C (host-tested, see test/test_display.c);
//   * only CHANGED bytes are sent, and only a bounded slice per iteration.
//
// Core1 publishes what it knows through a seqlock; core0 reads it, adds the
// track counter, and pumps. Core1 never touches the panel.
//
// Also load-bearing: nothing here drains wf_log. A display fed from the log
// would COMPETE with the USB console for records (wf_log_drain consumes), so
// attaching a terminal would blank the screen. It reads state directly.

// Bytes of payload per pump call. The cost of a call is (n + 8) bytes at
// 400 kHz and ~9 bits per byte -- 8 being the window commands and the control
// byte -- so 12 is ~450 us and 96 is ~2.3 ms.
//
// Two budgets because the real-time duty is not constant: while a disk is
// mounted the Amiga can be reading and core0 must stay responsive to STEP;
// with nothing mounted there is no floppy traffic at all and a slow, pretty
// redraw costs nobody anything. The seek deadline it must respect is head
// settle, ~15 ms, not the 1 ms loop period.
#define DISP_BUDGET_MOUNTED 12
#define DISP_BUDGET_IDLE    96

// How long the lemming holds each frame. ~8 steps a second, which is a brisk
// walk and not a twitch. Cheap by construction: a frame change dirties only
// the sprite's own 8 columns of one page (there is a test for that), so a step
// is a single pump call even at the mounted budget.
#define LEMMING_STEP_MS 120

static display_t  g_disp;
static uint8_t    g_panel_addr;          // 0 == no panel answered at boot

static bool panel_blit(void *ctx, int page, int col, const uint8_t *b, int n) {
    (void)ctx;
    return ssd1306_blit(g_panel_addr, g_disp.panel, page, col, b, n);
}

// ------------------------------------------------- display layouts (§6)
//
// Spec 2026-10-04 oled-layouts §6. core1 fetches GET /api/device/display when
// the poll's displayVersion is ahead of c.display_ack, validates the layout
// (layout_decode) and hands it to core0, which owns the panel. The handoff is
// two slots and a sequence: core1 fills the slot the sequence does NOT name,
// then advances the sequence behind a barrier; core0 copies the named slot and
// re-reads the sequence. ANY move during the copy means core1 may be writing
// the slot being read: its next publish after `s` writes slot (s+1)&1, but the
// one after that writes (s+2)&1 == s&1 -- this very slot -- and names it only
// once it is done, so a re-read in the middle of that write still sees s+1.
// Torn or not, core0 drops the copy and tries again next pass. Publishes are
// one per network round trip (seconds); core0's copy is microseconds, so in
// practice the retry never happens.
//
// core0 then applies it at once from RAM and writes it to flash later, only
// with the drive empty (display_store.h) -- in core0's own loop, so no disk can
// start being SERVED between the empty check and the write: serving a newly
// published slot is core0's job (track_cache_check_swap), and core0 is busy
// writing. That makes core0 the initiator of a flash_safe_execute for the
// first time, so core1 must be a lockout victim: core1_main calls
// flash_safe_execute_core_init() first thing.
typedef struct {
    display_record_t rec;     // version, panel, blob: what the store will hold
    layout_t         layout;  // decoded; meaningful only when rec.has_layout
} display_slot_t;
static display_slot_t     g_display_slots[2];   // core1 writes, core0 reads
static volatile uint32_t  g_display_seq;        // slot g_display_seq & 1 is the newest

// core0 only. g_disp.layout points at g_layout_applied whenever a custom
// layout is on (display_set_layout keeps the pointer), so it is static and is
// only ever rewritten by core0, between renders.
static layout_t           g_layout_applied;
static display_record_t   g_display_rec;            // what the deferred write saves
static bool               g_display_store_pending;
// Set by main() before core1 launches; core1 seeds c.display_ack from it.
static uint32_t           g_display_boot_ack;
// The panel type the board has: main() sets it from the stored record before
// core1 launches, and from then on only core1 writes it (each publish). It is
// the hardware's, not a device row's, so a re-pair keeps it (Ruling J).
static uint8_t            g_display_panel = PANEL_128x32;

/** core1: publish a validated display for core0. `l` NULL = the panel's
 *  default. `blob`/`bl` are the encoded layout as fetched, for the store. */
static void display_handoff_publish(uint8_t panel, const layout_t *l, uint32_t version,
                                    const uint8_t *blob, int bl) {
    const uint32_t s = g_display_seq;
    display_slot_t *slot = &g_display_slots[(s + 1u) & 1u];
    memset(slot, 0, sizeof *slot);
    slot->rec.version    = version;
    slot->rec.panel      = panel;
    slot->rec.has_layout = l ? 1 : 0;
    slot->rec.blob_len   = (uint8_t)(l ? bl : 0);
    if (l) {
        memcpy(slot->rec.blob, blob, (size_t)bl);
        slot->layout = *l;
    }
    __dmb();                 // the slot is whole before the sequence names it
    g_display_seq = s + 1u;
    g_display_panel = panel;
}

/** core1: the FRESH-board display -- this panel type's default layout under
 *  version 0 -- on the glass and (deferred) in the store. Both re-pair paths
 *  use it: the same-boot re-entry below, and a poll body that resets the
 *  cursor to 0 (dc_display_take_reset_to_default: a re-pair across a reboot,
 *  whose seeded ack was the old row's). The panel TYPE is kept (Ruling J). */
static void display_publish_fresh(const char *why) {
    display_handoff_publish(g_display_panel, NULL, 0, NULL, 0);
    wf_logf(WF_INFO, "display: %s -- default layout, version 0", why);
}

/** core0: copy the newest published slot if it is newer than *last. False =
 *  nothing new, or torn (ask again next pass). */
static bool display_handoff_take(uint32_t *last, display_slot_t *out) {
    const uint32_t s = g_display_seq;
    if (s == *last) return false;
    __dmb();
    *out = g_display_slots[s & 1u];
    __dmb();
    if (g_display_seq != s) return false;   // core1 may be writing this slot: retry
    *last = s;
    return true;
}

/** core0: put a taken slot on the glass, and owe the flash its record. The
 *  panel is re-initialised first when its type changed (ssd1306_reinit, then
 *  display_set_panel, then the layout -- the order display.h asks for).
 *  ssd1306_reinit, NOT ssd1306_init: init's synchronous full clear would block
 *  this loop for 12-25 ms of I2C, and display_set_panel's resend repaints
 *  every byte anyway, through the budgeted pump. */
static void display_apply(const display_slot_t *in) {
    const panel_t p = (panel_t)in->rec.panel;
    // The panel's rotation rides in the layout blob (1.17.0, REC_ROTATION);
    // no layout = the default = upright. Already validated by layout_decode.
    const uint8_t rot = in->rec.has_layout ? layout_rotation(in->rec.blob, in->rec.blob_len) : LAYOUT_ROT_0;
    if (g_panel_addr != 0) {
        const bool turned = rot != ssd1306_rotation();
        // Before a re-init, which sends the rotation it holds.
        if (turned && !ssd1306_set_rotation(g_panel_addr, rot))
            wf_logf(WF_WARN, "display: rotation %d failed", rot == LAYOUT_ROT_180 ? 180 : 0);
        if (p != g_disp.panel) {
            if (!ssd1306_reinit(g_panel_addr, p))
                wf_logf(WF_WARN, "display: panel re-init for %s failed",
                        p == PANEL_128x64 ? "128x64" : "128x32");
            display_set_panel(&g_disp, p);
        } else if (turned) {
            // The SSD1306 remaps only bytes written after the command: send
            // the whole picture again, through the budgeted pump.
            display_resend_all(&g_disp);
        }
        if (in->rec.has_layout) {
            g_layout_applied = in->layout;
            display_set_layout(&g_disp, &g_layout_applied);
        } else {
            display_set_layout(&g_disp, layout_default(p));
        }
    }
    g_display_rec = in->rec;
    g_display_store_pending = true;
    wf_logf(WF_INFO, "display: version %lu applied (%s, %s%s)%s",
            (unsigned long)in->rec.version, p == PANEL_128x64 ? "128x64" : "128x32",
            in->rec.has_layout ? "custom layout" : "default layout",
            rot == LAYOUT_ROT_180 ? ", turned 180" : "",
            g_panel_addr ? "" : " -- no panel attached, stored only");
}

// The published half: written by core1, read by core0. `g_ui_seq` is odd
// while the strings are being written, so a reader can tell it caught a torn
// update and simply try again on its next 1 ms turn -- a display is the one
// consumer for which "skip this frame" is a complete and correct answer.
static volatile uint32_t g_ui_seq;
static char g_ui_title[DISP_TITLE_MAX + 1];
static char g_ui_detail[DISP_DETAIL_MAX + 1];
static volatile int g_ui_status = DS_BOOT;
static volatile int g_ui_bars   = -1;
static volatile int g_ui_pct    = -1;
// Set from the SAME expression that drives the WPROT pin, never computed
// separately: a pencil that disagreed with the pin would be worse than no
// pencil, because it would be believed.
static volatile bool g_ui_writable = false;
// Same idea as g_ui_writable: set from up_sync(&up) at the same moment, on
// core1, and read by core0 in ui_snapshot below -- never computed from a
// cast, since up_sync_t and disp_sync_t are converted by a switch (see
// core1_main's WPROT block).
static volatile int g_ui_sync = DISP_SYNC_SYNCED;
// A tap's line (nfc_ui.h), published by core1 with the time it was published
// and a count of publications. core0 shows it OVER g_ui_detail while it is
// under NFC_UI_LINE_MS old (nfc_tag_clock_live, nfc_ui_detail), so the
// observer's line underneath is never overwritten and the revert is on time
// even while core1 sits in a 25 s held poll. The count is what lets core0 end
// a line for good: an age alone comes back when the ms clock wraps.
static char g_ui_tag[NFC_UI_LINE_BYTES];
static uint32_t g_ui_tag_at;
static uint32_t g_ui_tag_n;

// The server override (1.13.0, spec §2). Filled ONCE on core0 in main(), before
// core1 starts, and never changed after: a "wf server set/clear" stores the new
// record and reboots rather than switching servers under a running client. So
// core1 (dc_init, the poll log) and core0 (ui_snapshot, the console) read it
// without a lock.
static server_override_t g_server;           // the server this boot talks to (spec §2)
static char g_server_hdr[OVERRIDE_HOST_MAX + 7];

static void ui_publish(disp_status_t st, const char *title, const char *detail, int pct) {
    g_ui_seq++;                     // odd: writing
    __dmb();
    if (title)  snprintf(g_ui_title,  sizeof g_ui_title,  "%s", title);
    if (detail) snprintf(g_ui_detail, sizeof g_ui_detail, "%s", detail);
    __dmb();
    g_ui_seq++;                     // even: settled
    g_ui_status = (int)st;
    g_ui_pct    = pct;
}

/** core1: show `line` on the detail line for NFC_UI_LINE_MS from `now`. */
static void ui_publish_tag(const char *line, uint32_t now) {
    g_ui_seq++;                     // odd: writing
    __dmb();
    snprintf(g_ui_tag, sizeof g_ui_tag, "%s", line);
    g_ui_tag_at = now;
    g_ui_tag_n++;
    __dmb();
    g_ui_seq++;                     // even: settled
}

/** Copy the published state, and the tap line with its time and count. False
 *  means "torn, ask again" -- never a stale half-string handed to the renderer. */
static bool ui_snapshot(display_state_t *s, char tag[NFC_UI_LINE_BYTES], uint32_t *tag_at,
                        uint32_t *tag_n) {
    uint32_t a = g_ui_seq;
    __dmb();
    if (a & 1u) return false;
    memset(s, 0, sizeof *s);
    s->status   = (disp_status_t)g_ui_status;
    s->bars     = g_ui_bars;
    s->pct      = g_ui_pct;
    s->writable = g_ui_writable;
    s->sync     = (disp_sync_t)g_ui_sync;
    // core1 recomputes g_ui_sync only between requests, and a long poll holds
    // it for up to 25 s. A write core0 applied meanwhile must not read as
    // "synced": that is the one question the cloud answers ("can I switch
    // off now?"). core0 set these dirty flags itself, so it sees them at once.
    // Found on the bench 2026-09-19: ~6 s of a plain cloud over unsent writes.
    if (s->sync == DISP_SYNC_SYNCED && psram_image_dirty_count(psram_active_slot()) > 0)
        s->sync = DISP_SYNC_PENDING;
    memcpy(s->title,  g_ui_title,  sizeof s->title);
    memcpy(s->detail, g_ui_detail, sizeof s->detail);
    s->title[DISP_TITLE_MAX]   = '\0';
    s->detail[DISP_DETAIL_MAX] = '\0';
    memcpy(tag, g_ui_tag, NFC_UI_LINE_BYTES);
    tag[NFC_UI_LINE_BYTES - 1] = '\0';
    *tag_at = g_ui_tag_at;
    *tag_n  = g_ui_tag_n;
    __dmb();
    return g_ui_seq == a;
}

/** Just the dotted quad, for the panel's bottom line. default_route_str() is
 *  the diagnostic form ("w00 ip=..."), which is right for a console log and
 *  wrong for 21 characters of glass. Takes the lwIP lock, so core1 only --
 *  never from core0's service loop, and never from an interrupt. */
static const char *ip_str(void) {
    static char buf[20];
    net_radio_lock();
    struct netif *nif = netif_default;
    snprintf(buf, sizeof buf, "%s", nif ? ip4addr_ntoa(netif_ip4_addr(nif)) : "no route");
    net_radio_unlock();
    return buf;
}

/** RSSI to arcs. The thresholds are the ordinary ones for 2.4 GHz: -60 dBm is
 *  a strong link, -80 is the edge of usable. Below that the glyph shows a bare
 *  dot, which is honest -- it is associated, and barely. */
static int rssi_bars(int rssi) {
    if (rssi == 0)    return -1;      // not associated at all
    if (rssi >= -60)  return 3;
    if (rssi >= -70)  return 2;
    if (rssi >= -80)  return 1;
    return 0;
}

// Core1's view of the state machine, turned into words. Called from inside
// dc_step -- including from the image read loop -- so it must do nothing but
// format and store, which is all ui_publish does.
static void ui_observe(void *ctx, const dc_obs_t *o) {
    (void)ctx;
    char detail[DISP_DETAIL_MAX + 1];
    switch (o->kind) {
    case DC_OBS_FETCH_BEGIN:
        ui_publish(DS_DOWNLOAD, o->title[0] ? o->title : "Fetching", "", 0);
        break;
    case DC_OBS_FETCH_PROGRESS: {
        int pct = o->total ? (int)((uint64_t)o->got * 100u / o->total) : -1;
        snprintf(detail, sizeof detail, "%lu of %lu KB",
                 (unsigned long)(o->got / 1024u), (unsigned long)(o->total / 1024u));
        ui_publish(DS_DOWNLOAD, NULL, detail, pct);
        break;
    }
    case DC_OBS_VERIFY:
        ui_publish(DS_VERIFY, NULL, "checking image", -1);
        break;
    case DC_OBS_MOUNTED:
        // "3/13 Locale" on a set, the label alone on a one-disk game; no
        // word "Disk" (nfc_ui_disk_line, host-tested). The line is 21 wide.
        nfc_ui_disk_line(o->disk_no, o->disk_count, o->label, detail, sizeof detail);
        ui_publish(DS_LOADED, o->title[0] ? o->title : "Disk mounted", detail, -1);
        break;
    case DC_OBS_EJECTED:
        ui_publish(DS_READY, "No disk", "", -1);
        break;
    }
}

// Write-back is on unconditionally (write-back spec piece 2b): a whole,
// clean captured track is applied to the board's copy of the disk AND
// uploaded to the server by core1's uploader (uploader.c, driven from
// core1_main). WPROT follows the server's writeProtected flag, forced
// asserted whenever nothing is mounted or the uploader itself has been
// refused a write (up_forces_wprot) -- see core1_main's WPROT comment for
// how this is wired.

/*
 * WF_VERIFY_TRACKS -- after every mount, read each of the 160 tracks back out
 * of PSRAM and DECODE it the way the Amiga will, checking that all eleven
 * sectors recover with valid header and data checksums.
 *
 * Diagnostic, off by default (-DWF_VERIFY_TRACKS=1). It exists because an
 * Amiga reported an unreadable track that this board had demonstrably served
 * whole, from an image proven byte-identical to the upload, encoded to MFM
 * proven byte-identical to Greaseweazle on all 160 tracks. Everything software
 * could check had been checked EXCEPT the copy actually sitting in PSRAM at the
 * moment of serving -- image_loader verifies it once as it arrives and nothing
 * looks at it again.
 *
 * Bounded: ONE track per service-loop iteration, so a sweep costs ~160
 * iterations rather than one long stall in the loop that feeds the floppy.
 */
#ifndef WF_VERIFY_TRACKS
#define WF_VERIFY_TRACKS 0
#endif

/*
 * WF_BUS_SNIFF -- log every change on the eight bus inputs, in exact order,
 * from the bus_sniff PIO program. Diagnostic, off by default
 * (-DWF_BUS_SNIFF=1). While it is on, the GPIO ISR's own SEL and SIDE traces
 * are suppressed: they carry the same edges, in pin order and sampled late,
 * and would only compete with these for log slots.
 */
#ifndef WF_BUS_SNIFF
#define WF_BUS_SNIFF 0
#endif

static PIO  pio = pio0;
static uint sm_in;

// ---------------------------------------------------------------- DF1
// The board's second drive (spec 2026-10-08). DF1 is served only by a build
// with the drive-ID responder: its ID -- NONE while off, so Kickstart reads
// "no drive" -- comes from a drive_id state machine on SEL1.
#define DF1_CAPABLE WF_DRIVE_ID
// What DF1 does, from the stored setting (drive_store.h) at boot. core0 reads
// it in the STEP ISR and its loop; core1 hands it to device_client.
static volatile df1_mode_t g_df1_mode = DF1_MODE_OFF;
// R4: the stored setting's version at boot (0 = nothing stored). core1 seeds
// its driveAck cursor from it (Phase 3); written once, before core1 launches.
static volatile uint32_t g_drive_boot_ack;
// core1 -> core0: a new DF1 setting, applied live (D3, df1_live.h). core1
// writes the mode and the version, then bumps the seq; core0 applies when the
// seq differs from what it last applied, then publishes applied = that seq.
// A cursor, not a flag: a second change before the first is applied is just
// the next seq, and a re-sent one (core1 retrying) is applied again, which is
// idempotent.
static volatile uint8_t  g_df1_req_mode;
static volatile uint32_t g_drive_req_version;   // what the store record will say
static volatile uint32_t g_df1_req_seq, g_df1_applied_seq;

// Per drive (bus_out.h WF_DRIVES; 0 = DF0, 1 = DF1). n_drives is how many the
// board answers as -- set once at boot on core0, before the bus IRQs are
// enabled: 2 in a DF1-capable build, whatever the setting (DF1 off answers as
// an absent drive: ID NONE, every line released). cur_side is shared: SIDE is
// one bus line for every drive.
static volatile unsigned n_drives = 1;
static volatile int  cur_cyl[WF_DRIVES];
static volatile int  cur_side  = 0;
static volatile int  want_track[WF_DRIVES] = { -1, -1 };   // core0 -> core1 request
_Static_assert(WF_DRIVES == 2, "want_track's initializer names every drive");

// Sized for the longest track track_cache_get() can return -- an encoded HD
// track (TRACK_BUF_BYTES, track_cache.h) -- not the PSRAM stride.
static uint32_t track_words[TRACK_BUF_BYTES / 4];

// DF1's word buffer (D2). DD-sized by default: DF1 is handed only DD and HFE
// tracks then (an HD next disk leaves DF1 empty -- device_client's
// dc_df1_want and the mount below both check DF1_HOLDS_HD).
#if WF_DF1_HD
#define DF1_WORD_BUF_BYTES TRACK_BUF_BYTES
#else
#define DF1_WORD_BUF_BYTES TRACK_MAX_BYTES       // DD/HFE only (D2)
#endif
#define DF1_HOLDS_HD (DF1_WORD_BUF_BYTES >= ADF_MFM_HD_TRACK_BYTES)
#if DF1_CAPABLE
static uint32_t track_words1[DF1_WORD_BUF_BYTES / 4];
#endif

// ---------------------------------------------------------------- DMA feed
// One flux stream per drive: its DMA channel, flux_out state machine and word
// buffer, and -- touched from dma_irq (an ISR) and from start_streaming on
// core0, hence volatile -- whether it is live, the revolutions of the current
// stream, the previous stream's total, and whether this stream has already
// logged its INDEX. Not const: dma_irq runs from RAM and reads this table, so
// it stays in RAM too.
typedef struct {
    uint32_t         *words;
    uint32_t          cap_bytes;      // sizeof the word buffer
    uint32_t          count;          // words in the current track
    int               dma;            // -1: this drive has no stream (not configured)
    uint              sm;             // flux_out state machine on `pio`
    volatile bool     live;
    volatile uint32_t rev_count;
    volatile uint32_t prev_revs;
    volatile bool     index_traced;
} stream_t;
static stream_t g_stream[WF_DRIVES] = {
    { .words = track_words, .cap_bytes = sizeof track_words, .dma = -1 },
#if DF1_CAPABLE
    { .words = track_words1, .cap_bytes = sizeof track_words1, .dma = -1 },
#else
    { .words = NULL, .cap_bytes = 0, .dma = -1 },
#endif
};

#if WF_PNET_LOOP
// Phase 3 (plan 2026-10-12, ruling 2): the PaulaNET path runs only while this is true -- DF1 in Network mode
// (in the echo TEST build, Next disk too). core0 writes it (pnet_set_mode) at boot and on every live DF1
// change; the STEP and WGATE ISRs and the loop read it. False: DF1 is a plain disk drive.
#define PNET_ECHO_BUILD (!WF_PNET_L2)
static volatile bool g_pnet_on;
// PaulaNET Phase 2 (plan 2026-10-11-paulanet-phase2-rob-driver, Task 1): a start of DF1's side-1
// stream that is due later than now runs from a core0 alarm (pnet_go_later). Its id while pending,
// else 0. Core0 only: the loop stores it with interrupts off, the alarm's callback clears it first,
// and stream_stop(1) -- the one path every stop, rebuild or restart of DF1's stream takes -- cancels
// it, so a start never lands on a buffer being rebuilt or on a stream something else stopped.
#ifndef PNET_SIDE_DELAY_US
#define PNET_SIDE_DELAY_US 0u
#endif
#define PNET_GO_MIN_US 20u        // due sooner than this: start at once (an alarm costs about as much)
static volatile alarm_id_t g_pnet_go_alarm;
static void pnet_go_cancel(void) {
    const uint32_t irq = save_and_disable_interrupts();
    const alarm_id_t id = g_pnet_go_alarm;
    g_pnet_go_alarm = 0;
    if (id > 0) cancel_alarm(id);
    restore_interrupts(irq);
}
#if WF_PNET_L2
// Phase 2 (Task 4): DF1 streams cylinder 76's status loop (pnet_serve_status) from its own buffer, so
// DF1's word buffer keeps the batch the Amiga reads next on cylinder 77. dma_irq re-arms from it while
// this is set; stream_stop(1) clears it, so every other start streams `words` again.
static volatile bool g_pnet_status_live;
static uint32_t      g_pnet_status_words[PNET_STATUS_LOOP_BYTES / 4u];
#endif
#endif
// Stop drive d's stream at once: no re-arm at the next wrap, and the
// transfer in flight aborted.
static void stream_stop(unsigned d) {
    stream_t *s = &g_stream[d];
#if WF_PNET_LOOP
    if (d == 1) pnet_go_cancel();              // a start still pending would restart what this stops
#endif
    s->live = false;
#if WF_PNET_L2
    if (d == 1) g_pnet_status_live = false;    // dma_irq re-arms from `words` again
#endif
    if (s->dma >= 0) dma_channel_abort((uint)s->dma);
}

// Faster than any drive can step; see the STEP ISR. Pulses closer together than
// this are electrical, not mechanical.
#define STEP_MIN_INTERVAL_US 1000
// Counted rather than silently dropped: if this ever climbs during normal use,
// the threshold is wrong and the cure would be worse than the disease.
static volatile uint32_t steps_rejected;

// DIR comes from the step_dir PIO program (floppy.pio), latched as STEP falls.
// Measured 2026-09-14 across nine captures: inward seeks contained single pulses
// read as OUTWARD, each leaving cur_cyl two cylinders behind the Amiga, and 44
// of 59 such seeks were followed by the Amiga re-homing against 10 of 102 clean
// ones. The cause was reading DIR when the ISR ran rather than at the edge; the
// Amiga releases DIR ~30 us after the pulse.
//
// steps_dir_late counts the pulses where that old interrupt-time read would have
// disagreed with the latched value -- the misreads this now prevents, measured
// in the same run rather than inferred from a different one.
static PIO  step_pio = pio2;
static uint step_sm;
static volatile uint32_t steps_seen;
static volatile uint32_t steps_dir_late;
// STEP pulses with SEL0 released: another drive's, not acted on (bus_gate.h).
// Counted so the gate's effect is a number in the log, not an absence.
static volatile uint32_t steps_other_drive;
// SEL1 telemetry (spec 2026-10-08 §6 step 0). g_sel1_wired: any SEL1 fall
// since boot -- Kickstart reads DF1's ID with 34 selects at every reset
// (HANDOFF 4d), so a wired pin 12 shows within a second of power-on. The
// GPIO interrupt switches itself off after the first edge: a real DF1 being
// read would otherwise interrupt on every select. g_df1_steps: SEL1 steps that
// passed the 1 ms filter while the board's own DF1 is off.
static volatile bool     g_sel1_wired;
static volatile uint32_t g_df1_steps;
static absolute_time_t   g_df1_last_step;   // STEP ISR only

// Streams `bit_count` bits of `mfm` on drive d, looping. Copies them into
// drive d's word buffer at once, so `mfm` (a track_cache buffer, valid only
// until the next track_cache_get* on either drive -- R14) is never kept.
// False, with drive d's stream stopped, if d has no stream or the track does
// not fit its buffer (DF1's is DD-sized unless WF_DF1_HD): never an overflow.
static bool start_streaming(unsigned d, const uint8_t *mfm, uint32_t bit_count) {
    stream_t *s = &g_stream[d];
    uint32_t nwords = (bit_count + 31) / 32;

    // Review (final), Important 3: the abort MUST come before the repack
    // loop, not after it. The word buffer is the DMA's read address; clearing
    // `live` only stops dma_irq() re-arming at the next revolution wrap, it
    // does not stop a transfer already in flight. Rewriting the buffer
    // underneath a running channel hands the PIO a mixture of the outgoing
    // and incoming track for the remainder of that revolution -- one torn
    // revolution, which the Amiga reads as a bad sector on a drive that is
    // otherwise fine. That was survivable while this only ran on a seek; it
    // now also runs on every swap and on eject-then-remount, at times nobody
    // chose. (stream_stop clears `live` and aborts, in that order.)
    stream_stop(d);
    if (s->dma < 0) return false;
    if (bit_count > s->cap_bytes * 8u) {
        wf_logf(WF_ERR, "df%u: a %lu-bit track does not fit the %lu-byte stream buffer -- not served",
                d, (unsigned long)bit_count, (unsigned long)s->cap_bytes);
        return false;
    }

    // Carry the outgoing track's revolution count into the next INDEX record
    // and restart the counters. See dma_irq(): INDEX is traced ONCE per
    // stream, not once per revolution.
    s->prev_revs = s->rev_count;
    s->rev_count = 0;
    s->index_traced = false;

    // repack bytes MSB-first into words for autopull
    for (uint32_t i = 0; i < nwords; i++) {
        uint32_t w = 0;
        for (int b = 0; b < 4; b++) w = (w << 8) | mfm[i * 4 + b];
        s->words[i] = w;
    }
    s->count = nwords;
    const uint ch = (uint)s->dma;
    dma_channel_config c = dma_channel_get_default_config(ch);
    channel_config_set_transfer_data_size(&c, DMA_SIZE_32);
    channel_config_set_read_increment(&c, true);
    channel_config_set_write_increment(&c, false);
    channel_config_set_dreq(&c, pio_get_dreq(pio, s->sm, true));
    dma_channel_configure(ch, &c, &pio->txf[s->sm], s->words, s->count, true);
    dma_channel_set_irq0_enabled(ch, true);
    s->live = true;
    return true;
}

#if WF_PNET_LOOP
// The loopback's INDEX timing (TEST build). g_pnet_echo_live: DF1's stream is the cylinder-77
// echo, so its wrap pulse is PNET_INDEX_PULSE_US wide. g_pnet_idx_end_us: when drive 1's latest
// INDEX pulse ends (time_us_32), to tell a restart that cannot make a new edge. g_pnet_side_us:
// the latest SIDE edge (gpio_isr), for the SIDE -> restart INDEX latency. Stores only in ISRs.
static volatile bool     g_pnet_echo_live;
static volatile uint32_t g_pnet_idx_end_us, g_pnet_side_us;
#endif
// index pulse + wrap: retrigger DMA each revolution. `ud` is the drive.
static int64_t index_off(alarm_id_t id, void *ud) {
    (void)id;
    bus_out_set_drive((unsigned)(uintptr_t)ud, PIN_INDEX, false);
    return 0;
}
// Flash writes disable XIP. This handler re-arms the DMA each revolution and
// raises INDEX; stalling it mid-revolution presents to the Amiga as a
// malformed revolution -- a flaky drive, essentially undiagnosable without a
// scope.
//
// Review round 1, Minor M-1: moved into RAM with __not_in_flash_func, but
// this alone is NOT sufficient -- objdump shows this handler's own call
// graph still reaches into flash: the veneers it calls out through resolve
// to alarm_pool_get_default()/time_us_64()/alarm_pool_add_alarm_at(), and
// index_off() -- the callback add_alarm_in_us() installs below -- is itself
// a flash-resident function. What actually prevents this handler stalling
// mid-flash-write is main()'s flash_safe_execute_core_init() call, which
// lets core1's token write park core0 (interrupts disabled, nothing
// executing at all) for the write's duration -- see that comment for the
// real argument. __not_in_flash_func is kept anyway as a second, cheap
// layer, but it is not "either mitigation would suffice alone": only the
// lockout actually covers this handler's full call graph.
//
// One handler for both drives' channels (both on DMA_IRQ_0): each one that
// finished a revolution is acknowledged and re-armed on its own.
static void __isr __not_in_flash_func(dma_irq)(void) {
    const uint32_t pending = dma_hw->ints0;
    for (unsigned d = 0; d < WF_DRIVES; d++) {
        stream_t *s = &g_stream[d];
        if (s->dma < 0) continue;
        const uint32_t bit = 1u << (unsigned)s->dma;
        if (!(pending & bit)) continue;
        dma_hw->ints0 = bit;
        if (!s->live) continue;
#if WF_PNET_L2
        // DF1 on cylinder 76 loops the status records from their own buffer (pnet_serve_status).
        dma_channel_set_read_addr((uint)s->dma, (d == 1 && g_pnet_status_live) ? g_pnet_status_words : s->words,
                                  false);
#else
        dma_channel_set_read_addr((uint)s->dma, s->words, false);
#endif
        dma_channel_set_trans_count((uint)s->dma, s->count, true);
        bus_out_set_drive(d, PIN_INDEX, true);           // ~2 ms index at wrap
#if WF_PNET_LOOP
        // DF1 streaming the echo: the short pulse, so a read armed just after a wrap does not
        // wait out a pulse longer than the lead-in (see PNET_INDEX_PULSE_US). DF0 and disks: 2 ms.
        const uint32_t idx_us = (d == 1 && g_pnet_echo_live) ? PNET_INDEX_PULSE_US : INDEX_PULSE_US;
        if (d == 1) g_pnet_idx_end_us = time_us_32() + idx_us;
        add_alarm_in_us(idx_us, index_off, (void *)(uintptr_t)d, true);
#else
        add_alarm_in_us(INDEX_PULSE_US, index_off, (void *)(uintptr_t)d, true);
#endif
        s->rev_count++;
        // ONCE PER STREAM, NOT ONCE PER REVOLUTION, and the difference is not
        // cosmetic. At 300 RPM a per-revolution record is a permanent ~5 Hz
        // producer, and wf_log's ring keeps OLDEST and drops NEWEST -- a policy
        // written for bursts. Measured on a rev A2 board 2026-09-11: a board left
        // mounted and unattended for 8.6 h reported "151362 record(s) dropped",
        // which is INDEX alone (151362 / 4.93 Hz = 8.5 h). The ring saturates
        // about thirteen seconds after a disk mounts and stays that way, so ANY
        // later event -- a TRACK-MISS, an error, an eject -- is dropped before a
        // terminal can ever be attached. The boot history survives, which is the
        // policy working as designed; everything after it did not.
        //
        // Edge-triggered, this pairs with TRACK-SERVED: one line proving the DMA
        // actually wrapped on the track just loaded. `b` carries how many
        // revolutions the PREVIOUS track completed, which is the fact a
        // per-revolution flood was standing in for -- and it costs one record per
        // seek instead of five per second. A live "still spinning" indicator is
        // what the activity LED in the backlog is for; it is not the log's job.
        // `a` is the word count, with the drive in bits 24+ (0 for DF0, so
        // DF0's records read as before).
        if (!s->index_traced) {
            s->index_traced = true;
            wf_trace(WF_EV_INDEX, s->count | ((uint32_t)d << 24), s->prev_revs);
        }
    }
}

// ---------------------------------------------------------------- bus ISRs
// One step drive d acts on: today's DF0 handling, indexed by d. `late` is DIR
// as read at interrupt time, for steps_dir_late (DF0 only).
static void step_drive(unsigned d, bool outwards, bool late) {
    /*
     * Reject pulses that arrive faster than a drive can step.
     *
     * Measured on real hardware 2026-09-13: a burst of SIXTEEN STEP edges
     * inside one millisecond, with the direction bit reversing seven times
     * within it. A burst like that random-walks the cylinder counter -- and
     * nothing corrects it until the Amiga recalibrates against TRK0. From then
     * on this board serves a track the Amiga did not ask for: valid MFM whose
     * sector headers name the wrong cylinder, which trackdisk correctly calls a
     * read error.
     *
     * A real Amiga steps every ~3-4 ms (measured: 120 gaps in 2-4 ms, and NOT
     * ONE below 2 ms across 454 pulses). 1 ms therefore rejects only what no
     * drive could produce, with a factor of two in hand. Timed at interrupt
     * time, so pulses drained together from the FIFO count as a burst.
     *
     * The burst was seen once, at a power event, so this is hardening rather
     * than a fix for anything yet observed -- but a corrupted cylinder counter
     * survives until recalibration, which makes one occurrence enough to matter.
     */
    // One clock per drive: zero at boot, so each drive's first pulse passes,
    // and one drive's seek never resets another's filter.
    static absolute_time_t last_step[WF_DRIVES];
    const absolute_time_t now_us = get_absolute_time();
    if (absolute_time_diff_us(last_step[d], now_us) < STEP_MIN_INTERVAL_US) {
        steps_rejected++;
        return;
    }
    last_step[d] = now_us;

    // DIRC high = towards 0
    if (outwards) { if (cur_cyl[d] > 0) cur_cyl[d]--; }
    else          { if (cur_cyl[d] < NUM_CYL - 1) cur_cyl[d]++; }
    bus_out_set_drive(d, PIN_TRK0, cur_cyl[d] == 0);
#if WF_PNET_LOOP
    // PaulaNET (Network mode): DF1 is writable on cylinder 77 only, set the moment the head gets there --
    // trackdisk reads WPROT when a write starts, and PaulaNET's driver writes right after a seek.
    if (d == 1 && g_pnet_on) bus_out_set_drive(1, PIN_WPROT, pnet_df1_wprot(cur_cyl[1]));
#endif
    dskchg_on_step_d(d);
    want_track[d] = cur_cyl[d] * 2 + cur_side;
    if (d != 0) return;            // the log and the counters are DF0's
    wf_trace(WF_EV_STEP, (uint32_t)cur_cyl[0], outwards ? 1u : 0u);
    steps_seen++;
    if (late != outwards) {
        steps_dir_late++;
        wf_trace(WF_EV_DIR_LATE, (uint32_t)cur_cyl[0], late ? 1u : 0u);
    }
    // No LED here: the activity LED is a level core0's loop sets (led_activity.h).
}

// One STEP pulse, with the selects and DIR as latched by the PIO at its
// falling edge. Every drive this board is serving whose select was low steps.
static void step_pulse(uint32_t word) {
    const bus_step_t st = bus_step_decode(word);
    const unsigned nd = n_drives;
    // Selects of drives this board is serving (bit d = drive d): DF0 always,
    // DF1 while its machines run -- on, or PARKED (switched off live, still an
    // empty drive to a running Amiga; df1_live.h). An OFF DF1 is configured
    // but its machines are disabled: not a drive, its head never moves, and
    // its steps are the telemetry below -- the df1-seen heuristic counts only
    // while our DF1 answers as no drive at all (spec §3).
    const uint8_t serving = df1_serving_mask(nd, bus_out_drive_enabled(1));
    const uint8_t ours = st.sel_mask & serving;
    // Another drive's step. Checked before anything else: it must not move the
    // head, clear CHNG, or count towards the too-fast filter, whose clock a
    // DF1 seek would otherwise reset. With DF1 off this is exactly "SEL0
    // released", as before.
    if (ours == 0) {
        steps_other_drive++;
        if (st.sel_mask & BUS_SEL_DF1) {
            const absolute_time_t t = get_absolute_time();
            // Same 1 ms rule as DF0's, with its own clock: the power-event
            // burst must not count as a drive.
            if (absolute_time_diff_us(g_df1_last_step, t) >= STEP_MIN_INTERVAL_US) g_df1_steps++;
            g_df1_last_step = t;
        }
        return;
    }

    // DIR as read NOW, at interrupt time -- what the GPIO ISR used to act on.
    // Compared against the latched value for steps_dir_late, never used.
    const bool late = gpio_get(PIN_DIR);

    for (unsigned d = 0; d < nd; d++)
        if (ours & (1u << d)) step_drive(d, st.outwards, late);
}

// RX-not-empty on the step_dir state machine: one word per pulse. Drains the
// FIFO so a burst cannot leave a pulse waiting for the next interrupt.
static void __isr step_pio_isr(void) {
    while (!pio_sm_is_rx_fifo_empty(step_pio, step_sm))
        step_pulse(pio_sm_get(step_pio, step_sm));
}

// pio1 carries the SEL0 gating: status_gate (bus_out.c) and sel_mtr, and
// nothing else (DF1's second SMs join them there). flux_in, step_dir and the
// diagnostic sniffer sit on pio2 with the CYW43 radio, which claims its SM
// there last, from net_radio_sta_enable() on core1 (the SDK's
// pio_claim_free_sm_and_add_program_for_gpio_range searches pio2 first and
// needs a free SM and 6 free instruction slots there).
static PIO  bus_pio = pio1;
// One sel_mtr state machine per configured drive (in_base = its select); -1:
// none. Written once at boot, before the interrupt is enabled.
static int  mtr_sm[WF_DRIVES] = { -1, -1 };

// sel_mtr pushes the MTR level latched on each select fall, only when it
// changes -- one machine for SEL0, one for SEL1 in a DF1-capable build.
static void __isr mtr_pio_isr(void) {
    for (unsigned d = 0; d < WF_DRIVES; d++) {
        if (mtr_sm[d] < 0) continue;
        while (!pio_sm_is_rx_fifo_empty(bus_pio, (uint)mtr_sm[d])) {
            const bool running = (pio_sm_get(bus_pio, (uint)mtr_sm[d]) & 1u) != 0;
            // DF1 off: kept (dskchg's RDY needs an image too, so nothing is
            // asserted), but not traced -- 1.7.8 logged no DF1 motor at all.
            dskchg_on_motor_d(d, running);
            if (d == 0 || g_df1_mode != DF1_MODE_OFF)
                wf_trace(WF_EV_MOTOR, running ? 1u : 0u, d);
        }
    }
}

// core0 loop, on bus_power's BUS_POWER_LOST: the Amiga is off, and the motor
// latch keeps whatever the power-down's last select fall caught -- "on", on
// the bench (2026-10-09), which held a staged update forever. Clears every
// configured drive's motor flag and re-arms each sel_mtr so its next latch is
// reported whatever it is (`mov y, ~null`, the program's own first
// instruction): without that, an Amiga powering up with the motor on would
// match the stale "on" in Y and never be pushed. With interrupts off, so a
// push already in the FIFO (a select fall, i.e. a live bus) is applied after
// this, not under it. Returns a mask of the drives whose flag was on.
static unsigned mtr_force_off(void) {
    unsigned was_on = 0;
    const uint32_t irq = save_and_disable_interrupts();
    for (unsigned d = 0; d < WF_DRIVES; d++) {
        if (mtr_sm[d] < 0) continue;
        if (dskchg_motor_on_d(d)) was_on |= 1u << d;
        dskchg_on_motor_d(d, false);
        // mov_not is encoded correctly in pico-sdk 2.3.0 (only pio_encode_mov
        // to osr/exec is broken -- run.sh).
        pio_sm_exec(bus_pio, (uint)mtr_sm[d], pio_encode_mov_not(pio_y, pio_null));
    }
    restore_interrupts(irq);
    return was_on;
}

#if WF_BUS_SNIFF
static uint sniff_sm;
static volatile uint32_t sniff_records, sniff_gaps, sniff_violations;

// Drains bus_sniff. Order is exact; the timestamp is taken here, so it is late
// by the interrupt latency. A set RXSTALL means the PIO dropped at least one
// sample because the FIFO was full: flagged on the next record drained (bit
// 16), so the gap lies within the eight records before it. `a` is a GPIO mask
// (bit n = GPn; WDATA and RDATA never sampled).
static void __isr sniff_isr(void) {
    const uint32_t stall = 1u << (PIO_FDEBUG_RXSTALL_LSB + sniff_sm);
    while (!pio_sm_is_rx_fifo_empty(step_pio, sniff_sm)) {
        uint32_t a = bus_sniff_decode(pio_sm_get(step_pio, sniff_sm));
        if (bus_sniff_violation(a)) sniff_violations++;
        if (step_pio->fdebug & stall) {
            step_pio->fdebug = stall;
            sniff_gaps++;
            a |= 1u << 16;
        }
        sniff_records++;
        wf_trace(WF_EV_BUS, a, (uint32_t)time_us_64());
    }
}
#endif

static volatile int write_track;     // set when WGATE asserts
// The disk that was mounted when WGATE asserted. A write belongs to that disk
// and no other; write_back_verdict() rejects it if a swap landed since.
static volatile int32_t write_token;
// WGATE asserted with SEL0 released: another drive being written. Not
// captured -- capturing it would apply DF1's write to DF0.
static volatile uint32_t writes_other_drive;
static volatile bool     write_ours;
#if WF_PNET_LOOP
// PaulaNET loopback (TEST build): the loop's df1_mounted, for the WGATE ISR, and whether the
// write in progress is DF1's cylinder-77 batch -- its own flag, so write_ours stays DF0's alone.
static volatile bool     g_pnet_df1_mounted;
static volatile bool     pnet_write_ours;
// A raw batch armed and not yet taken by pnet_take_capture(), and the batches a DF0 write threw
// away: DF0's arm re-initialises the shared capture buffer, so a batch still waiting is lost.
// Accounting only: the loop clears it after a take or a timeout, and an arm landing just before
// that clear can go uncounted -- harmless, since nothing decides a disarm from it.
static volatile bool     pnet_raw_pending;
static volatile uint32_t g_pnet_lost;
// WGATE asserts on DF1's cylinder 77 that did not arm: the capture was not idle
// (flux_capture_idle). That is a DF0 capture armed, waiting to be taken or still being decoded --
// arming over it would destroy DF0's write; the Amiga resends -- but also a WGATE glitch mid-write
// re-entering the branch over this write's own arm, and a raw batch still waiting for the loop
// (back-pressure). So a busy count is not only DF0 contention.
static volatile uint32_t g_pnet_busy;
// Whether THIS DF1 write armed the raw capture: set at its WGATE assert only when that assert
// really armed one (a busy or glitch assert leaves it as it was), read and cleared at its release
// and by the capture timeout when nothing is armed -- the release disarms on this alone, never on
// pnet_raw_pending, which the loop also clears (a clear landing after a new arm would leave
// that arm running).
static volatile bool     pnet_armed_this_write;
// The pre-arm (pnet_loop.h, flux_capture.h), cumulative; the 5 s line prints each window's share.
// pre_used: DF1 batches whose WGATE claimed a standing pre-arm. pre_df0 / pre_other: pre-arms
// cancelled by a DF0 write's WGATE / by any other assert (another drive, a powered-down bus).
// Written in gpio_isr; the loop's own (arms, cancels, stray discards) are core0-loop only.
static volatile uint32_t g_pnet_pre_used, g_pnet_pre_df0, g_pnet_pre_other;
static uint32_t          g_pnet_pre_arms, g_pnet_pre_cancel, g_pnet_pre_stray;
#endif

// Written by core0 when a write lands, read by core1's uploader. g_write_gen
// is a seqlock (write_back_gen_begin/_end, final review F1): odd from before
// the store's first byte until the track is DIRTY and g_write_last_ms is set,
// even once all of that is visible -- so a reader that sees the new even gen
// also sees the time of the write that made it, and up_close can tell a store
// in progress from a settled one.
static volatile uint32_t g_write_last_ms;
static volatile uint32_t g_write_gen;
// Stamped in the WGATE ISR on both edges (see gpio_isr below) -- unlike
// g_write_last_ms, this marks the Amiga TOUCHING the write path at all, not
// only a capture that was later accepted. A torn/bad-checksum/wrong-track/
// overflowed capture never reaches g_write_last_ms, so without this the idle
// window (REINSERT_IDLE_MS, reinsert_may_announce) could pass immediately
// after such a write -- exactly the case it exists to avoid.
static volatile uint32_t g_wgate_last_ms;
// core0 -> gpio_isr: the Amiga's side of the bus is unpowered (bus_power.h:
// all seven inputs low for BUS_UNPOWERED_MS). Its WGATE "assertion" is then
// not a write, and no capture is armed for it.
static volatile bool g_bus_unpowered;
// core1 -> core0: the write-protect flag changed on the SAME mounted disk, so
// the Amiga must be told the way an insert is (reinsert.h). core0 acts on it
// only while the Amiga is idle -- see REINSERT_IDLE_MS -- and drops it if the
// disk itself changes first, since the mount/eject path announces that.
static volatile bool g_reinsert_req;
// When g_reinsert_req was (most recently) raised -- reinsert_may_announce's
// deadline (REINSERT_FORCE_MS) is measured from this, so a request that the
// idle/motor/WGATE gate never lets through is still announced eventually
// instead of silently starving forever.
static volatile uint32_t g_reinsert_raised_ms;
static uint32_t wb_write_gen(void)    { return g_write_gen; }
static uint32_t wb_last_write_ms(void) { return g_write_last_ms; }

static uint32_t clock_ms(void) {
    return to_ms_since_boot(get_absolute_time());
}

// Free heap, conservatively: only the never-claimed space between the break
// and __StackLimit, the ceiling the SDK's _sbrk refuses to grow past
// (pico_clib_interface/newlib_interface.c; 0x20080000 in this build's map,
// with the stacks above it in scratch RAM). Chunks malloc holds free below
// the break are NOT counted, so the real figure is at least this.
// HD spec §7 bench step 10: HD grew the SRAM buffers by ~33 KB, and this is
// the number that says what that left.
//
// How the break is learned matters more than the arithmetic. Core0 must
// never call sbrk()/_sbrk() itself, not even sbrk(0): the SDK's _sbrk is a
// read-modify-write of its static heap_end that stores it back even for an
// increment of 0, and a call from here runs outside malloc's lock while
// core1 (mbedTLS, lwIP) may be growing the heap -- a lost update there
// corrupts the heap. mallinfo() is out for the same reason (it walks the
// heap unlocked). Instead CMakeLists.txt links with -Wl,--wrap=_sbrk, so
// every heap growth malloc makes -- under its own lock, on whichever core --
// passes through __wrap__sbrk, which records the new break in one aligned
// word. heap_free_bytes() only LOADS that word.
extern char __StackLimit;
extern char end;                       // linker: first byte of the heap (= __end__)
void *__real__sbrk(ptrdiff_t incr);
static volatile uintptr_t g_heap_break;    // 0 = no growth yet: the break is `end`

void *__wrap__sbrk(ptrdiff_t incr) {
    char *prev = __real__sbrk(incr);
    if (prev != (char *)-1) {
        // PICO_USE_OPTIMISTIC_SBRK may hand out less than asked, clamped to
        // __StackLimit; the break is never past it.
        uintptr_t brk = (uintptr_t)prev + (uintptr_t)incr;
        if (incr > 0 && brk > (uintptr_t)&__StackLimit) brk = (uintptr_t)&__StackLimit;
        g_heap_break = brk;
    }
    return prev;
}

static uint32_t heap_free_bytes(void) {
    uintptr_t brk = g_heap_break;
    if (brk == 0) brk = (uintptr_t)&end;
    return (uint32_t)((uintptr_t)&__StackLimit - brk);
}

// ---------------------------------------------------------------- NFC tap
//
// Tap-to-mount (spec 2026-09-25 §4). The reader is core0's: it shares i2c1
// with the OLED, and the bus belongs to core0, so nfc_step() runs in the
// display pump's slot (main()'s loop). The network is core1's: a TAG_READ
// becomes POST /tap there. Single-slot seqlock mailboxes carry the rest
// (nfc_handoff.h): reader events one way (WRITE_DONE in a box of its own, so
// no tap can replace an untaken result), the write request the other.
// Every decision about what to show, and when a write request ends, is in
// nfc_ui.c; this section only moves values between the cores.
static nfc_reader_t   g_nfc;           // core0 only
static nfc_ev_boxes_t  g_nfc_ev;       // core0 -> core1
static nfc_wreq_box_t  g_nfc_wreq;     // core1 -> core0
static nfc_ev_cursor_t g_nfc_ev_cur;   // core1's cursors into g_nfc_ev
static nfc_report_t    g_nfc_report;   // core1 only: the write report owed the server
// The reader as a LEVEL, not an event: 0 = not checked yet, 1 = present,
// 2 = absent. Written by core0 after every nfc_step, read by core1 for the
// status report. A level because the event slot keeps only the newest event,
// and a PRESENT overwritten by a tap before core1 looked would leave the
// server believing "absent" (or nothing) for as long as the chip stayed.
static volatile int   g_nfc_reader;
// The boot I2C scan's record (i2c_scan.h): written once by core0's init, before
// core1 is launched, and only read after -- by the status report (dc_set_i2c_scan).
// Never rescanned: the OLED and the tag reader share i2c1.
static i2c_scan_t     g_i2c_scan;

/** core1, from inside tls_read's wait while a poll is held: cut the poll
 *  short, a tap is waiting (device_client.h). One load. */
static bool nfc_event_pending(void *ctx) {
    (void)ctx;
    return nfc_ev_boxes_pending(&g_nfc_ev, &g_nfc_ev_cur);
}

// g_write_last_ms as it was just before core1 began the current long poll:
// the write cursor's mark (poll_wake.h). core1 only.
static uint32_t g_poll_write_mark;

/** core1, from inside tls_read's wait while a poll is held: cut the poll
 *  short when a tap is waiting OR a write has landed since the poll began,
 *  so a save made during a held poll is uploaded at once instead of when
 *  the poll comes back (HANDOFF 3av). Two loads. */
static bool poll_wake_pending(void *ctx) {
    return poll_should_yield(nfc_event_pending(ctx), g_write_last_ms, g_poll_write_mark);
}

/** core0, in the display pump's slot: never both on the bus in one pass.
 *  Arms or disarms on a new write request, expires one after two minutes,
 *  runs one budgeted step, and forwards what it produced to core1.
 *  `short_pass`: a disk is mounted AND no panel answered, so the bus is still
 *  at the probe's 100 kHz -- one register op there is ~0.5 ms of a pass the
 *  Amiga is waiting on, so the reader gets 1 op instead of 4. */
static void nfc_core0_step(nfc_armed_t *armed, bool short_pass) {
    static uint32_t wreq_last;
    const uint32_t now = clock_ms();
    nfc_wreq_t req;
    if (nfc_wreq_box_take(&g_nfc_wreq, &wreq_last, &req)) {
        if (req.next) {
            // Multi-disk: the Next-disk card. No disk id, and not a disarm.
            nfc_arm_write_next(&g_nfc, req.seq);
            nfc_armed_set(armed, req.seq, "Next-disk card", now);
            wf_logf(WF_INFO, "nfc: write %lu armed (Next-disk card)", (unsigned long)req.seq);
        } else if (req.disk_id[0]) {
            nfc_arm_write(&g_nfc, req.seq, req.disk_id);
            nfc_armed_set(armed, req.seq, req.title, now);
            wf_logf(WF_INFO, "nfc: write %lu armed (%s)", (unsigned long)req.seq, req.disk_id);
        } else {
            nfc_disarm(&g_nfc);
            nfc_armed_clear(armed);
            wf_logf(WF_INFO, "nfc: write %lu disarmed", (unsigned long)req.seq);
        }
    }
    if (nfc_armed_expired(armed, now)) {       // true once; it has ended `armed`
        nfc_disarm(&g_nfc);
        wf_logf(WF_INFO, "nfc: write %lu expired on the board (2 min)", (unsigned long)armed->seq);
    }

    nfc_set_max_ops(&g_nfc, short_pass ? 1 : NFC_MAX_OPS_PER_STEP);
    nfc_step(&g_nfc);
    const int level = nfc_present(&g_nfc) ? 1 : 2;
    if (level != g_nfc_reader) {
        g_nfc_reader = level;
        // Which chip, and where: a PN532 module is told apart from the Si512
        // here and in the boot I2C scan's address list, nowhere else.
        if (level == 1 && nfc_chip(&g_nfc) == NFC_CHIP_PN532)
            wf_logf(WF_INFO, "nfc: reader present (PN532) at 0x%02x", PN532_I2C_ADDR);
        else if (level == 1)
            wf_logf(WF_INFO, "nfc: reader present (Si512) at 0x%02x", NFC_I2C_ADDR);
        else
            wf_logf(WF_INFO, "nfc: reader absent (0x%02x, 0x%02x)", NFC_I2C_ADDR, PN532_I2C_ADDR);
    }
    // The dropout measurement (nfc_reader.h nfc_gap_t): the 3 s re-arrival
    // window is a guess from three bench sightings, and these lines are how
    // the board says how long a lying tag's dropouts really are. (A Next-disk
    // card's window is 1 s: its re-taps came back after 1.4-1.7 s, 2026-10-18.)
    nfc_gap_t gap;
    if (nfc_take_gap(&g_nfc, &gap))
        wf_logf(WF_INFO, "nfc: held tag %02X%02X%02X%02X unseen %lu ms %s",
                gap.uid[0], gap.uid[1], gap.uid[2], gap.uid[3], (unsigned long)gap.ms,
                gap.new_arrival ? "-> new arrival" : "(still the same tap)");
    // Every pass: while an event waits in the reader's slot, nfc_step does
    // nothing at all (nfc_reader.h).
    nfc_event_t ev;
    if (nfc_take_event(&g_nfc, &ev)) {
        nfc_armed_on_event(armed, &ev);
        if (ev.uid_len > 0) led_blip();         // a tag arrived (spec §4.4)
        // PRESENT/ABSENT travel as g_nfc_reader above; forwarded, they would
        // wake a held poll for nothing and could overwrite a waiting tap.
        if (ev.kind != NFC_EV_PRESENT && ev.kind != NFC_EV_ABSENT)
            nfc_ev_route(&g_nfc_ev, &ev);
    }
}

/** core1: writes on the board the server has not yet got -- dirty tracks on
 *  the mounted disk, or an uploader with any session at all (working, open, or
 *  parked). Multi-disk spec §4.3's "no dirty or unsent tracks": the preload
 *  gate refuses on it. Deliberately wider than the swap hold (up_holds), which
 *  is what a Next-disk tap's "Saving, then disk N" follows instead.
 *  up_has_work() first: it runs up_refresh(), which unparks on a mount change,
 *  before `parked` is read. */
static bool swap_hold_check(void *up, bool decide);   // below, after g_motor_on

static bool writes_outstanding(uploader_t *up) {
    const bool work = up_has_work(up);
    return work || up_pending(up) || up->parked ||
           psram_image_dirty_count(psram_active_slot()) > 0;
}

/** core1: the multi-disk preload gate (dc_set_preload_gate). The idle slot is
 *  used only when nothing else could want it or the network: no outstanding
 *  writes (above), no held swap (up_holds -- the writes half of dc_set_hold's
 *  swap_holds; a preload never touches the disk the Amiga is using, so the
 *  Amiga-idle half does not apply), and no firmware update between being offered and applied (QUEUED,
 *  DOWNLOADING, STAGED, APPLYING, REBOOTING; FAILED is terminal and IDLE is
 *  nothing). Asked by dc_preload_step, between requests, on core1 only. */
typedef struct {
    uploader_t  *up;
    const fwu_t *fwu;
} preload_gate_t;

static bool preload_ok(void *ctx) {
    const preload_gate_t *g = (const preload_gate_t *)ctx;
    if (writes_outstanding(g->up)) return false;
    if (up_holds(g->up)) return false;
    if (g->fwu->phase != FWU_IDLE && g->fwu->phase != FWU_FAILED) return false;
    return true;
}

/** core1, between requests: a write's result first (it is held as a report
 *  owed the server, and shown), then one tap or other reader event, then the
 *  owed report -- last, and not at all on a pass that had a tap, so a send
 *  blocking through DNS/connect/read timeouts on a dead network never delays
 *  one (nfc_report_turn). The report is kept until the server has HEARD it
 *  (any 2xx), retried on its own schedule (2 s doubling to 60 s -- core1's
 *  pass can turn every ~50 ms while the uploader waits, so "every pass" is
 *  not a rate); a newer write request makes it moot (nfc_core1_write_request). */
static void nfc_core1_event(device_client_t *c, uploader_t *up) {
    static uint32_t warned_seq;                 // log a failed report once per seq
    const bool online = c->state != DC_UNPROVISIONED && c->state != DC_HALTED;
    char uid[NFC_UI_UID_HEX_BYTES];
    nfc_event_t ev;
    if (nfc_ev_box_take(&g_nfc_ev.done, &g_nfc_ev_cur.done, &ev)) {
        nfc_report_hold(&g_nfc_report, &ev);
        nfc_ui_uid_hex(&ev, uid);
        wf_logf(ev.ok ? WF_INFO : WF_WARN, "nfc: write %lu to tag %s: %s%s",
                (unsigned long)ev.seq, uid, ev.ok ? "ok" : "FAILED ",
                ev.ok ? "" : (ev.why ? ev.why : "?"));
        ui_publish_tag(nfc_ui_event_line(&ev), clock_ms());
    }
    bool tapped = false;
    if (nfc_ev_box_take(&g_nfc_ev.taps, &g_nfc_ev_cur.taps, &ev)) {
        tapped = true;
        char line[NFC_UI_LINE_BYTES];
        const char *show;
        if (ev.kind == NFC_EV_TAG_READ) {
            static char title[DC_TITLE_MAX + 1];    // static: core1's stack is measured tight
            const dc_tap_outcome_t o = online ? dc_tap(c, ev.disk_id, title, sizeof title)
                                              : DC_TAP_FAILED;
            show = nfc_ui_tap_line(o, title, line, sizeof line);
            wf_logf(WF_INFO, "nfc: tap %s -> %s", ev.disk_id, show);
        } else if (ev.kind == NFC_EV_TAG_NEXT) {
            // Multi-disk: the Next-disk card. The swap it asks for waits
            // behind unsent writes exactly while the hold says so
            // (dc_set_hold's swap_holds), and the glass says "Saving" on that
            // same predicate -- not the preload gate's wider one, which also
            // counts a parked session whose tracks the swap will not wait for.
            uint32_t no = 0, count = 0;
            static char title[DC_TITLE_MAX + 1];    // static: core1's stack is measured tight
            const dc_tap_outcome_t o = online ? dc_tap_next(c, &no, &count, title, sizeof title)
                                              : DC_TAP_FAILED;
            const bool saving = swap_hold_check(up, false);
            show = nfc_ui_next_line(o, no, count, saving, line, sizeof line);
            wf_logf(WF_INFO, "nfc: next -> %s", show);
        } else {
            show = nfc_ui_event_line(&ev);
            if (show) wf_logf(WF_INFO, "nfc: %s", show);
        }
        if (show) ui_publish_tag(show, clock_ms());
    }
    // A tap that arrived while this one was handled goes first too.
    tapped = tapped || nfc_ev_box_pending(&g_nfc_ev.taps, g_nfc_ev_cur.taps);
    if (online && nfc_report_turn(&g_nfc_report, clock_ms(), tapped, &ev)) {
        nfc_ui_uid_hex(&ev, uid);
        const bool heard = dc_tap_write_report(c, ev.seq, ev.ok, uid, ev.why);
        nfc_report_sent(&g_nfc_report, ev.seq, heard, clock_ms());
        if (heard) {
            wf_logf(WF_INFO, "nfc: write %lu reported", (unsigned long)ev.seq);
        } else if (warned_seq != ev.seq) {
            warned_seq = ev.seq;
            wf_logf(WF_WARN, "nfc: write %lu report not delivered -- retrying (2 s, doubling to 60 s)",
                    (unsigned long)ev.seq);
        }
    }
}

/** core1, after a poll delivered nfcWrite: hand it to core0, and ack it. */
static void nfc_core1_write_request(device_client_t *c) {
    nfc_wreq_t req;
    memset(&req, 0, sizeof req);
    req.seq = c->nfc_write_seq;
    snprintf(req.disk_id, sizeof req.disk_id, "%s", c->nfc_write_disk_id);
    req.next = c->nfc_write_next;
    // A newer request (or its withdrawal) makes an unreported older result
    // moot: the server would acknowledge and ignore it as stale.
    nfc_report_supersede(&g_nfc_report, req.seq);
    if (req.disk_id[0]) snprintf(req.title, sizeof req.title, "%s", c->nfc_write_title);
    nfc_wreq_box_put(&g_nfc_wreq, &req);
    // Acted on -- armed or disarmed -- so say so, or the server keeps its
    // hold released and the poll keeps coming back with the same request.
    c->nfc_ack = c->nfc_write_seq;
    c->nfc_write_new = false;
}

// core1 only: the display fetch's retry schedule. A fetch that fails (offline,
// a 5xx) is NOT handled -- the version stays owed and is fetched again -- but
// not on every pass: the server keeps answering the poll at once while the
// version is owed, so an unpaced retry would be a request storm. 2 s,
// doubling, capped at 60 s, reset by any fetch that completes.
static bool     g_display_fetch_failing;
static uint32_t g_display_retry_at;
static uint32_t g_display_retry_wait;

static void display_fetch_backoff(void) {
    g_display_retry_wait = g_display_retry_wait ? g_display_retry_wait * 2u : 2000u;
    if (g_display_retry_wait > 60000u) g_display_retry_wait = 60000u;
    g_display_retry_at = clock_ms() + g_display_retry_wait;
    g_display_fetch_failing = true;
}

/** core1, between requests: fetch, validate and hand over the owed display.
 *  True when a version was HANDLED (applied or refused) -- a status report is
 *  then owed, carrying the new displayVersion and displayError. Every decision
 *  is dc_display_decide's (pure, host-tested); this is only what it causes. */
static bool display_core1_fetch(device_client_t *c) {
    if (g_display_fetch_failing && (int32_t)(clock_ms() - g_display_retry_at) < 0) return false;
    // static: core1's stack is measured tight (see CORE1_STACK_BYTES).
    static uint8_t dbuf[8 + LAYOUT_BLOB_MAX];
    static dc_display_verdict_t vd;
    const uint32_t want = c->display_want;
    const int n = dc_fetch_display(c, dbuf, (int)sizeof dbuf);
    switch (dc_display_decide(c, dbuf, n, &vd)) {
    case DC_DISP_RETRY:
        // Nothing complete arrived, or an answer older than the poll's word
        // (a lagging read on the server): neither applied nor acked.
        display_fetch_backoff();
        wf_logf(WF_WARN, "display: fetch for version %lu %s -- retry in %lu s",
                (unsigned long)want, n < 0 ? "failed" : "answered with an older version",
                (unsigned long)(g_display_retry_wait / 1000u));
        return false;
    case DC_DISP_MALFORMED:
    case DC_DISP_REJECT:
        dc_display_handled(c, vd.version, vd.why);
        wf_logf(WF_WARN, "display: version %lu refused -- %s (%d bytes)",
                (unsigned long)vd.version, vd.why, n);
        break;
    case DC_DISP_APPLY:
        display_handoff_publish(vd.panel, vd.blob_len ? &vd.layout : NULL, vd.version,
                                vd.blob, vd.blob_len);   // core0 applies; store deferred
        dc_display_handled(c, vd.version, NULL);
        break;
    }
    g_display_fetch_failing = false;
    g_display_retry_wait = 0;
    return true;
}

static void __isr gpio_isr(uint gpio, uint32_t events) {
    if (gpio == PIN_SEL1 && (events & GPIO_IRQ_EDGE_FALL)) {
        g_sel1_wired = true;
        gpio_set_irq_enabled(PIN_SEL1, GPIO_IRQ_EDGE_FALL, false);   // one edge is the reading
        return;
    }
    if (gpio == PIN_SEL0 && (events & GPIO_IRQ_EDGE_FALL)) {
        if (!WF_BUS_SNIFF) wf_trace(WF_EV_SEL, 1, 0);
    } else if (gpio == PIN_WGATE) {
        /*
         * The Amiga is writing. WGATE brackets exactly one track, so this is
         * the only signal that says when the flux on WDATA is worth anything.
         *
         * Both branches are deliberately cheap -- a few register writes and no
         * decoding. Everything expensive (turning intervals into bits, finding
         * sectors, checking their checksums) happens in the service loop,
         * because this runs in an ISR on the core that has to keep serving
         * the bus while the write is still going on.
         *
         * Active low, like every other input through the '541.
         */
        // Both edges, unconditionally, before anything else in this branch --
        // see g_wgate_last_ms's comment. ISR: a volatile store only, no log.
        g_wgate_last_ms = clock_ms();
        bool writing = !gpio_get(PIN_WGATE);
        // An unpowered bus reads WGATE asserted: nobody is writing. (The
        // power-down's own fall comes before core0 can know; the capture
        // timeout and the interval floor below catch that one.)
#if WF_PNET_LOOP
        // Not a write, but WDATA floats with the rest: a standing pre-arm goes (pnet_loop.h).
        if (writing && g_bus_unpowered && flux_capture_prearm_cancel()) g_pnet_pre_other++;
#endif
        if (writing && g_bus_unpowered) return;
#if WF_PNET_LOOP
        // Loopback (TEST build): DF1 writing cylinder 77, side 0, is a PaulaNET batch -- a raw
        // capture for pnet_take_capture(), never a disk write. Checked before the SEL0 rule
        // below, which would count it as another drive's write and drop it.
        if (writing && gpio_get(PIN_SEL0) &&
            pnet_capture_ours(g_pnet_df1_mounted, false, !gpio_get(PIN_SEL1), cur_cyl[1], cur_side)) {
            pnet_write_ours = true;              // set either way: its release is ours too
            bool armed_now = false;
            if (flux_capture_prearm_claim()) {
                // Armed ahead of this write by the loop (pnet_prearm_step): it is this write's
                // now, its first edge sync pulse 1 -- no arm latency at all.
                armed_now = true;
                g_pnet_pre_used++;
            } else if (flux_capture_idle()) {
                flux_capture_arm_raw();
                armed_now = !flux_capture_idle();          // only if the arm really happened
            } else {
                g_pnet_busy++;
            }
            // Set, never cleared, here: a WGATE glitch mid-write re-enters this branch, finds the
            // capture armed (busy, armed_now false), and must not erase this write's arm -- or its
            // release would skip the disarm. Only the release clears it, with pnet_write_ours.
            if (armed_now) pnet_armed_this_write = true;
            if (armed_now) pnet_raw_pending = true;        // for the `lost` count only
            wf_trace(WF_EV_WGATE, 1u, 0x100u | (uint32_t)PNET_TRACK_IN);
            return;
        }
        if (!writing && pnet_write_ours) {
            pnet_write_ours = false;
            const bool ours = pnet_armed_this_write;
            pnet_armed_this_write = false;
            if (ours) flux_capture_disarm();               // never a capture this write did not arm
            wf_trace(WF_EV_WGATE, 0u, 0x100u | (uint32_t)PNET_TRACK_IN);
            return;
        }
        // Every other assert ends a standing pre-arm, which no write owns: DF0's write (SEL0) then
        // arms below exactly as it would without one (arm() would cancel it too), and another
        // drive's write would only put its flux in the ring.
        if (writing && flux_capture_prearm_cancel()) {
            if (!gpio_get(PIN_SEL0)) g_pnet_pre_df0++; else g_pnet_pre_other++;
        }
        // A DF0 write about to arm over a batch the loop has not taken yet: count it, as lost.
        if (writing && !gpio_get(PIN_SEL0) && pnet_raw_pending) {
            pnet_raw_pending = false;
            g_pnet_lost++;
        }
#endif
        /*
         * Only DF0's writes. SEL0 is read here, at interrupt time, and that is
         * enough -- unlike STEP's DIR -- because the Amiga holds the drive
         * selected for the whole ~200 ms write, not for microseconds.
         */
        if (writing && gpio_get(PIN_SEL0)) {
            writes_other_drive++;
            return;
        }
        if (!writing && !write_ours) return;     // the end of someone else's
        write_ours = writing;
        if (writing) {
            // The track under the head NOW. By the time the service loop logs
            // the decode the Amiga may have stepped, which produced a false
            // "track says 69, head is on 70" on 2026-09-15.
            write_track = cur_cyl[0] * 2 + cur_side;
            write_token = psram_active_token();
            flux_capture_arm();
        } else {
            flux_capture_disarm();
        }
        wf_trace(WF_EV_WGATE, writing ? 1u : 0u, (uint32_t)(cur_cyl[0] * 2 + cur_side));
    } else if (gpio == PIN_SIDE) {
        cur_side = gpio_get(PIN_SIDE) ? 0 : 1;       // low = side 1
#if WF_PNET_LOOP
        g_pnet_side_us = time_us_32();               // a store only: the restart latency's start
#endif
        // SIDE is one line for every drive: each configured drive's request moves.
        for (unsigned d = 0; d < n_drives; d++) want_track[d] = cur_cyl[d] * 2 + cur_side;
        if (!WF_BUS_SNIFF) wf_trace(WF_EV_SIDE, (uint32_t)cur_side, (uint32_t)want_track[0]);
    }
}

// Coarse "psramFree" for the status report (device_client.h): there is no
// general allocator here -- PSRAM is two fixed whole-disk slots
// (psram_image.h) -- so this reports headroom in whichever slot core1 is
// free to fetch into (psram_inactive_slot()), the only one it ever writes.
static int psram_free_estimate(void) {
    if (!psram_image_available()) return 0;
    return psram_image_missing_count(psram_inactive_slot()) * (int)TRACK_MAX_BYTES;
}

static int wifi_rssi(void) {
    return (int)net_radio_rssi();
}

// Renders lwIP's default route. This exists for ONE open question that plan
// 4b's ledger has carried unanswered since it was written: whether
// portal_stop() really restores the STA netif as netif_default after the
// provisioning AP tears down, or leaves it NULL. Nothing else on the board
// can answer it -- a wrong answer looks exactly like "TLS is broken", since
// every handshake fails with no route and no message. Call it AFTER
// portal_stop() and after association.
//
// Reads under the lwIP lock: cyw43_arch_lwip_begin()/end() is recursive, so
// this is safe from core1's ordinary flow. Never call it from an interrupt.
static const char *default_route_str(void) {
    static char buf[48];
    net_radio_lock();
    struct netif *nif = netif_default;
    if (!nif) {
        net_radio_unlock();
        return "NONE -- netif_default is NULL";
    }
    snprintf(buf, sizeof buf, "%c%c%d ip=%s", nif->name[0], nif->name[1],
             nif->num, ip4addr_ntoa(netif_ip4_addr(nif)));
    net_radio_unlock();
    return buf;
}

static void mac_address_string(char *out, size_t out_len) {
    uint8_t mac[6] = {0};
    net_radio_mac(mac);
    snprintf(out, out_len, "%02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

// ---------------------------------------------------------------- core 1
// Core 1's stack. multicore_launch_core1() would put this in SCRATCH_X --
// PICO_CORE1_STACK_SIZE, which defaults to 2 KB and cannot exceed the
// 4 KB the whole SCRATCH_X bank holds. Neither figure is enough, and the
// reason is not this file's own frames:
//
//   * core1_main -> dc_step -> dc_exchange -> tls_connect reaches
//     mbedtls_ctr_drbg_seed -> block_cipher_df -> aes_gen_tables, ~2.0 KB
//     of mbedTLS below tls_connect alone.
//   * pico_cyw43_arch_lwip_threadsafe_background services lwIP from a
//     low-priority IRQ on THIS core, so altcp_mbedtls_lower_recv ->
//     mbedtls_ssl_handshake -> ..._hkdf_expand_label -> sha256 (~2.6 KB)
//     lands on this same stack, on top of whatever the foreground is
//     doing, at a moment nothing here chooses.
//
// Task 7 re-measured this after adding the portal's DHCP/DNS/HTTP servers
// to this same core, rather than assuming the AP and TLS phases not
// overlapping in TIME means their stack use doesn't need re-checking --
// plan 4a's 2 KB-stack Critical happened by exactly that kind of
// unverified assumption. Method: built ELF, `-fstack-usage` per function,
// cross-referenced against `arm-none-eabi-objdump -d`'s actual `bl`
// targets (not guessed from names) to find the actual longest call chain
// by summed frame size, with the two known indirect edges (dc_exchange's
// transport_t calls into tls_connect/tls_write/tls_read; lwIP's
// callback-based dispatch into the recv handlers) bridged by hand since a
// static disassembly can't see through a function pointer.
//
//   * Foreground, core1_main down through tls_connect's mbedtls setup
//     (mbedtls_ctr_drbg_seed -> ctr_drbg_reseed_internal -> block_cipher_df
//     -> aes_gen_tables): 2536 B, confirmed by an independent re-derivation
//     (round 2 review). (Before this task, with core1_main's smaller
//     pre-provisioning frame: 2304 B -- this task's +232 B here is
//     entirely provisioning_t/device_config_t locals in core1_main itself;
//     see its definition.)
//   * IRQ: the first pass here started counting from
//     altcp_mbedtls_lower_recv (2576 B down through the deepest branch of
//     the TLS 1.3 client handshake state machine --
//     mbedtls_ssl_tls13_compute_handshake_transform -> ..._evolve_secret
//     -> ..._hkdf_expand_label -> PSA's HMAC/SHA-256 path, found by
//     exhaustively comparing every branch of mbedtls_ssl_tls13_handshake_
//     client_step's dispatch, not just the one named here; the
//     next-largest, ...compute_application_transform, is close behind).
//     That undercounted the true chain by 448 B -- the same mistake plan
//     4a's original 2 KB estimate made, missing everything ABOVE the
//     point picked as the walk's root. The actual root is the vector:
//     low_priority_worker_irq -> async_context_base_execute_once ->
//     cyw43_poll_worker -> cyw43_poll_func -> cyw43_ll_ioctl ->
//     cyw43_do_ioctl -> cyw43_cb_process_ethernet -> ethernet_input ->
//     ip4_input -> tcp_input, +312 B of dispatch this core also pays for
//     every inbound packet before ever reaching altcp_mbedtls_lower_recv.
//     Separately, the hardware exception entry itself is not the 32 B
//     basic AAPCS frame this comment implicitly assumed -- runtime_init.c
//     enables the FPU (CPACR CP10/11), and alarm_pool_irq_handler/
//     mbedtls_sha256 both use `d`-registers (vpush/vldr), so FPCA is set
//     and every exception on this core stacks the extended ~104 B frame,
//     not the basic one. 2576 + 312 (dispatch) + 104 (exception frame) =
//     2992, 32 B short of the confirmed 3024 B total -- that residual is
//     8-byte AAPCS alignment padding accumulating across the ~10 frames
//     in the dispatch/handshake chain above, not separately itemized;
//     conservative direction, not chased further. IRQ chain total: 3024 B.
//   * TLS path worst case (sum, matching plan 4a's IRQ-lands-on-
//     whatever-the-foreground-is-doing reasoning): 2536 + 3024 = 5560 B.
//   * Portal path, same accounting (core1_main + portal_run's own frame
//     blocked in its `while (!g_submitted) sleep_ms(5)` poll, plus the
//     deepest of the three servers' IRQ-invoked chains, the same corrected
//     dispatch prefix and exception frame included): ~2260 B -- still well
//     under the TLS path, since the AP phase never has a live TLS
//     connection to service concurrently. CORE1_STACK_BYTES is unchanged.
//
// Worst case is therefore 5560 B (TLS path), up from the ~4.9 KB this
// comment previously recorded (partly core1_main's own growth, partly two
// missed pieces of the IRQ chain above), which no SCRATCH_X-resident stack
// can hold regardless. Beyond 4 KB the only option is a stack in main SRAM
// launched via multicore_launch_core1_with_stack(); 16 KB leaves
// 16384 - 5560 = 10824 B (~66% headroom) of margin against a build with
// ~390 KB of SRAM unallocated, and the MSPLIM stack guard
// (PICO_USE_STACK_GUARDS in CMakeLists.txt) turns any future overrun into
// a hard fault rather than silent heap corruption. 32-byte aligned because
// the guard rounds the limit address up to a 32-byte boundary.
#define CORE1_STACK_BYTES 16384
static __attribute__((aligned(32))) uint32_t core1_stack[CORE1_STACK_BYTES / 4];

// Maps a failed cyw43_arch_wifi_connect_timeout_ms() into one of the two
// corrections spec §6 requires the portal to distinguish, plus a generic
// fallback -- a bare "failed" would send the user back to retype a
// password that was already right. Per pico_cyw43_arch.h's own
// documentation of this call: PICO_ERROR_BADAUTH means the password was
// wrong; PICO_ERROR_TIMEOUT means the timeout elapsed without ever
// joining, which for a *_timeout_ms() (as opposed to *_blocking()) call
// is what a persistently-unmatched SSID looks like --
// cyw43_arch_wifi_connect_bssid_until() (pico-sdk's cyw43_arch.c) treats
// CYW43_LINK_NONET as "keep retrying" internally rather than surfacing it,
// so the timeout is the only signal this call exposes for "never found
// it". Anything else (PICO_ERROR_CONNECT_FAILED, etc.) gets the fallback.
static const char *assoc_failure_message(int err) {
    if (err == PICO_ERROR_BADAUTH)  return "Wrong password";
    if (err == PICO_ERROR_TIMEOUT)  return "Network not found";
    return "Could not connect";
}

// transport_tls.c keeps a clean TLS connection open between requests, which
// is worth ~1.25 s per request and costs a pcb plus ~32 KB of mbedTLS
// buffers held for as long as it is open. Two things have to give it back,
// and neither is a request failing:
//
//   * leaving the poll loop, or going anywhere near the portal. portal_run()
//     raises an AP; a socket from the STA side must not outlive that, and
//     the memory is wanted for the portal's own stack and sockets. That is
//     unconditional, and it is what this function is for.
//   * idling past the point the transport would reuse it. That one is
//     conditional and belongs to the transport, which knows when the
//     connection went idle and what its own cap is: it is
//     tls_release_if_unreusable(), called once per pass of each loop below.
//     Round 3 replaced three "release before a sleep this long" guards with
//     that single per-pass rule -- guarding on sleep LENGTH missed every
//     busy-wait, notably the uploader's, which backs off to 60 s in 50 ms
//     naps and so never sleeps long enough to trip a guard.
//
// abandon(), never close(): close() is allowed to hand the socket back, and
// on these paths there is nothing to hand it back to.
static void release_kept_connection(void) {
    transport_t *t = tls_transport();
    if (t && t->abandon) t->abandon(t);
}

// ---------------------------------------------------------------- firmware update (2b)
//
// 2b staging (spec D3): a verified download lives here until it is flashed.
// Separate from the disk image's two slots (psram_image.c), which take ~4.26 MB
// of the 8 MB; 2 MB here is the release cap (FW_MAX_IMAGE_BYTES).
// __uninitialized_psram ONLY: PSRAM is brought up by main() itself
// (PICO_RUNTIME_SKIP_INIT_PSRAM=1), after crt0 has run, so nothing initialised
// may live there -- crt0 would copy into it before it exists.
static __uninitialized_psram("fwstage") uint8_t g_fw_stage[FW_MAX_IMAGE_BYTES];
// Set by main() after PSRAM is up (runtime_init_setup_psram) and
// psram_image_init has run: true only if the stage's last byte really is
// backed by PSRAM. updateProtocol is declared only when it is.
static volatile bool g_fw_stage_ok;

// fwu_ops_t (fw_update.h). All of these run on core1, from fwu_step in
// core1_main's poll loop -- fw_apply_image in particular takes seconds and
// may never run on core0, which feeds the 8 s watchdog (fw_apply.h).
static int fwu_fetch(void *ctx, const char *version, fw_stage_t *stage) {
    const int status = dc_fetch_firmware((device_client_t *)ctx, version, fw_stage_sink, stage);
    if (status != 200) {
        // dc_fetch_firmware has said where the exchange ended; this adds the
        // memory picture at that moment, which only this file can see. The
        // suspicion being tested (2026-10-09): a TLS allocation -- a record
        // buffer is one contiguous ~16 KB chunk -- fails on a heap that has
        // been fragmenting for hours. `fail`/`last` answer that directly.
        tls_mem_stats_t m;
        tls_mem_stats(&m);
        wf_logf(WF_WARN, "fw: heap free>=%lu tls held=%lu peak=%lu fail=%lu last=%lu",
                (unsigned long)heap_free_bytes(), (unsigned long)m.held,
                (unsigned long)m.peak, (unsigned long)m.fails,
                (unsigned long)m.last_fail_bytes);
    }
    return status;
}
static fw_apply_result_t fwu_apply(void *ctx, const uint8_t *img, uint32_t len,
                                   const char *sha, uint32_t *slot_off) {
    (void)ctx;
    uint32_t off, slot_len;
    if (!fw_rom_other_slot(&off, &slot_len)) return FWA_TOO_BIG;   // unpartitioned: no OTA
    *slot_off = off;
    return fw_apply_image(&fw_rom_flash, off, slot_len, img, len, sha);
}
static bool fwu_save(void *ctx, const fw_state_t *st) { (void)ctx; return fw_state_save(st); }
// FLASH_UPDATE into the OTHER slot (the one just written): the new image then
// trial-boots. fw_rom_request_reboot never overwrites an already-pending
// request (g_boot_cs, fw_rom.c); core0's fw_rom_service performs it (M9).
static void fwu_reboot(void *ctx, uint32_t off) { (void)ctx; fw_rom_request_reboot(off); }

// Published by core0 every loop turn. core1 reads it for the update's idle
// gate (D6) and the swap hold (swap_holds); dskchg.c's own state stays core0's.
static volatile bool g_motor_on;
// When the motor last came on (dskchg_motor_on_ms), published with g_motor_on:
// swap_holds counts it as activity (swap_gate.h, review I1).
static volatile uint32_t g_motor_on_ms;
#if WF_PNET_L2
// PaulaNET Phase 1: when cylinder 77 last carried a batch (a capture taken, or a batch streamed),
// clock_ms; 0 = never. core0 writes it; core1's update gate reads it (pnet_ota_quiet).
static volatile uint32_t g_pnet_last_ms;
// Phase 3 (the status report's `net`, plan 2026-10-12 ruling 13). core0 writes, core1 reads:
// when cylinder 76 was last served (clock_ms | 1; 0 = not since Network mode began), and the frames the Amiga
// sent that were taken / the frames it acknowledged (saturated where they are reported).
static volatile uint32_t g_pnet_status_last_ms, g_pnet_frames_from, g_pnet_frames_to;
// Phase 2: what core0 needs from core1 for cylinder 76's status track (pnet_serve_status). The MAC is
// written once by core1 after the bridge starts, then g_pnet_mac_ok, with a barrier between. The RSSI
// is core1's heartbeat sample, dBm (0 until the first).
static uint8_t          g_pnet_mac[6];
static volatile bool    g_pnet_mac_ok;
static volatile int16_t g_pnet_rssi;
#endif
// Published by core1 at the top of every pass: up_holds(&up), captured writes
// the server has not got. core0's DF1 store rule reads it (drive_store_idle,
// R17). A stale false (core1 inside a long network call) costs only margin:
// the store also needs SWAP_IDLE_MS of write silence and the motor off, and a
// flash write never touches the unsent tracks, which live in PSRAM.
static volatile bool g_up_holds;

/** DIAGNOSTIC (OTA stall, HANDOFF 2026-10-09). The raw input pads, as the
 *  74LVC541 buffer presents them: 1 = high = released, 0 = low = asserted
 *  (every floppy input is active low). With the Amiga switched off, rev B's
 *  1 kOhm pull-ups hang from its dead +5 V and every line reads 0 -- "all
 *  low" in the line says so. Any core, plain loop context (gpio_get only). */
static void bus_pads_str(char *buf, size_t cap) {
    const int sel0 = gpio_get(PIN_SEL0), sel1 = gpio_get(PIN_SEL1), mtr = gpio_get(PIN_MTR),
              wg = gpio_get(PIN_WGATE), step = gpio_get(PIN_STEP), dir = gpio_get(PIN_DIR),
              side = gpio_get(PIN_SIDE);
    const bool all_low = !(sel0 | sel1 | mtr | wg | step | dir | side);
    snprintf(buf, cap, "pads SEL0=%d SEL1=%d MTR=%d WGATE=%d STEP=%d DIR=%d SIDE=%d%s",
             sel0, sel1, mtr, wg, step, dir, side,
             all_low ? " (ALL LOW: bus unpowered? Amiga off?)" : "");
}

/** core1, once per poll-loop pass after fwu_step: the updater's phase, its
 *  retry timer and every idle-gate input, plus the pads (fw_update.h's
 *  fwu_diag_due decides when: every 10 minutes, on a phase change, and on a
 *  gate-input change while an update is in flight). Static buffers: core1's stack is measured tight. */
static void fwu_diag_tick(const fwu_diag_in_t *in, uint32_t now_ms) {
    static fwu_diag_t d;
    static char line[192], pads[96];
    if (!fwu_diag_due(&d, in, now_ms)) return;
    fwu_diag_format(line, (int)sizeof line, in, now_ms);
    bus_pads_str(pads, sizeof pads);
    wf_logf(WF_INFO, "%s | %s", line, pads);
}

/** core1: dc_set_hold's fn -- may the mounted disk be released (swap, Next
 *  tap, eject)? Not while the server lacks a write the board captured
 *  (up_holds), and not while the Amiga has not finished with the disk
 *  (swap_gate.h): AmigaDOS writes a file's header and directory blocks after
 *  its data, and a swap in between lost Locale's block 597 on 2026-09-29.
 *  The inputs are reinsert's (an applied write, a WGATE edge, the motor
 *  latch, WGATE now) plus when the motor came on. `decide` is false for a
 *  query that releases nothing (the panel's "Saving" line): no log. */
static bool swap_hold_check(void *up, bool decide) {
    static bool forced_logged;
    if (up_holds(up)) { if (decide) forced_logged = false; return true; }
    const bool motor_on = g_motor_on;
    const bool wgate = !gpio_get(PIN_WGATE);
    const uint32_t last_activity_ms =
        swap_gate_last_activity(g_write_last_ms, g_wgate_last_ms, motor_on, g_motor_on_ms);
    bool forced;
    if (!swap_gate_idle(clock_ms(), motor_on, wgate, last_activity_ms, &forced)) {
        if (decide) forced_logged = false;
        return true;
    }
    if (decide && forced && (motor_on || wgate) && !forced_logged) {
        forced_logged = true;
        // Ordinary for a trackloader game (motor on all session, never
        // writes) as well as for a powered-off Amiga.
        wf_logf(WF_INFO, "hold: released with the motor on or WGATE asserted -- "
                         "no activity for %u ms", (unsigned)SWAP_FORCE_MS);
    }
    return false;
}
static bool swap_holds(void *up) { return swap_hold_check(up, true); }

#if DF1_CAPABLE
// core1, dc_set_df1_quiesce's fn (R15): up to 50 ms for core0 (a ~1 ms loop)
// to acknowledge DF1's new word -- stop DF1's stream, then psram_df1_reader_ack
// -- before core1 writes the slot DF1 held. False: core0 has not let go yet;
// device_client defers the write (c.df1_deferred) and core1_main paces it.
static bool df1_quiesce_wait(void *ctx) {
    (void)ctx;
    for (int i = 0; i < 50; i++) { if (psram_df1_quiescent()) return true; sleep_ms(1); }
    return psram_df1_quiescent();
}
#endif

// The claimed state machines of each PIO as a bit mask per PIO.
static void pio_claim_masks(unsigned m[3]) {
    for (unsigned p = 0; p < 3; p++) {
        m[p] = 0;
        for (unsigned sm = 0; sm < 4; sm++)
            if (pio_sm_is_claimed(pio_get_instance(p), sm)) m[p] |= 1u << sm;
    }
}

static void core1_main(void) {
    // OLED layouts: core0 writes the display record to flash itself (see the
    // display layouts section at the top), so core0 must be able to park this
    // core -- the mirror of main()'s flash_safe_execute_core_init() for core1's
    // own writes. Before the radio: nothing on this core may write flash
    // before it, and nothing on core0 does until a layout arrives.
    flash_safe_execute_core_init();
    if (net_radio_init()) {
        // This loop never exits, but core0 is what drains the log, so this
        // line does get out -- which is the whole reason the drain lives
        // there and not here.
        wf_logf(WF_ERR, "radio init failed, radio is dead");
        while (1) tight_loop_contents();
    }
    wf_logf(WF_INFO, "radio up (RM2)");
    // The radio takes its PIO state machine inside net_radio_sta_enable()
    // (not in net_radio_init()), so the claim masks are read on both sides of
    // it: the "pio claims" line below is only true once the radio has claimed.
    unsigned before[3];
    pio_claim_masks(before);
    net_radio_sta_enable();
    {
        // Masks are SM bit masks (hex). Expected with DF1 (Task 16), in
        // claim order -- the same whatever the DF1 setting:
        //   pio0=f  flux_out DF0, flux_out DF1, drive_id DF0, drive_id DF1
        //   pio1=f  status_gate DF0, status_gate DF1, sel_mtr DF0, sel_mtr DF1
        //   pio2=7  flux_in, step_dir, radio      (f in a WF_BUS_SNIFF build:
        //                                          flux_in, step_dir, sniff, radio)
        // A WF_DRIVE_ID=OFF build serves no DF1: pio0=1 (flux_out), pio1=3.
        unsigned m[3];
        pio_claim_masks(m);
        wf_logf(WF_INFO, "pio claims: pio0=%x pio1=%x pio2=%x", m[0], m[1], m[2]);
        // The layout needs the radio on pio2: DF1's SMs fill pio0/pio1. A
        // silent fallback elsewhere would break that, so say so.
        if (m[2] == before[2] || m[0] != before[0] || m[1] != before[1])
            wf_logf(WF_WARN, "pio claims: the radio did NOT land on pio2 "
                             "(pio0 %x->%x pio1 %x->%x pio2 %x->%x)",
                    before[0], m[0], before[1], m[1], before[2], m[2]);
        else
            wf_logf(WF_INFO, "pio claims: radio on pio2 (%x -> %x)", before[2], m[2]);
    }
#if WF_PNET_L2
    pnet_bridge_start();          // the input hook and the send worker (plan 2026-10-11)
    net_radio_mac(g_pnet_mac);    // Phase 2: for cylinder 76's status track, published once
    __dmb();
    g_pnet_mac_ok = true;
#endif

    // Plan 4b: decide whether to serve the captive portal or run plan 4a's
    // protocol loop against stored credentials. Touches no radio itself
    // (provisioning.h's file-wide rule) -- prov.state is what the loop
    // below acts on.
    provisioning_t prov;
    prov_init(&prov);

    // Shown on the portal form after a failed association with freshly
    // submitted credentials (spec D-4b-3's verify-then-commit). NULL
    // until that happens.
    const char *last_error = NULL;

    for (;;) {
        if (prov.state == PROV_PORTAL) {
            // The catch-all, deliberately here rather than only at the sites
            // that set PROV_PORTAL: this is the single door every route into
            // the portal goes through, so a future one cannot miss it. The
            // AP goes up a few lines below, and a kept STA socket must not
            // still be holding its buffers when it does.
            release_kept_connection();
            wf_logf(WF_INFO, "portal: raising AP%s%s",
                    last_error ? ", last error: " : "", last_error ? last_error : "");
            // Blocks until a POST /save decodes to a complete
            // device_config_t. portal_run() tears down any sockets still
            // up from a previous call itself (it is re-entrant-safe), so
            // looping back here after a failed verify below needs no
            // extra teardown first.
            {
                uint8_t mac[6] = {0};
                net_radio_mac(mac);
                char ssid[DISP_DETAIL_MAX + 1];
                snprintf(ssid, sizeof ssid, "wifi-floppy-%02X%02X", mac[4], mac[5]);
                // The SSID to join, not the IP: standing at the board, the
                // question is which network to look for on a phone. The
                // portal's address is handed over by DNS once joined.
                ui_publish(DS_PORTAL, "Setup needed", ssid, -1);
            }
            device_config_t submitted;
            // Final-review Important 2: the wait is bounded ONLY when
            // there is a stored configuration worth going back to.
            //   * have_config true: the portal was opened by three
            //     consecutive association failures, so the credentials in
            //     flash may simply have lost a race with a router that was
            //     still booting. Re-try them every PORTAL_IDLE_TIMEOUT_MS
            //     of nobody touching the AP, so an unattended board
            //     self-heals instead of parking in AP mode forever.
            //   * have_config false: a factory-fresh board, or one whose
            //     config prov_on_pairing_code_rejected() just erased.
            //     There is nothing to re-try, so 0 (wait forever) --
            //     timing out would only bounce the AP under whoever is
            //     mid-form for no gain.
            uint32_t portal_wait_ms =
                prov.have_config ? PORTAL_IDLE_TIMEOUT_MS : 0u;
            portal_run_result_t pr =
                portal_run(&submitted, last_error, portal_wait_ms);

            if (pr == PORTAL_RUN_IDLE_TIMEOUT) {
                // Same teardown as the submit path below -- an idle
                // timeout leaves the AP up exactly as a submission does,
                // and the retry attempt underneath needs STA back as
                // lwIP's default route just as much.
                portal_stop();
                // Back to PROV_RUNNING with a fresh set of attempts
                // against prov.cfg. If those fail too, prov_on_assoc_
                // result() opens the portal again and this repeats --
                // which is the intended shape: a slow sweep, not a
                // permanent strand.
                prov_on_portal_idle_timeout(&prov);
                continue;
            }

            // Load-bearing, and must run before the connect attempt
            // below, not after: bringing the AP up made it lwIP's
            // default route, and portal_stop() is what restores the STA
            // netif cyw43_arch_enable_sta_mode() registered above as
            // netif_default. Skipping this (or reordering it after the
            // connect) leaves the board associated with no route to
            // anywhere, and every TLS handshake in the RUNNING loop below
            // fails as a result.
            portal_stop();
            wf_logf(WF_INFO, "portal: AP down, default route now %s",
                    default_route_str());

            int err = net_radio_sta_connect(submitted.ssid, submitted.pass, 15000);
            if (err != PICO_OK) {
                last_error = assoc_failure_message(err);
                wf_logf(WF_WARN, "portal: association failed (%d): %s",
                        err, last_error);
                continue;   // portal_run() comes back up showing last_error
            }

            // Verify-then-commit (spec D-4b-3): reaches here only once
            // this exact association has just succeeded, so committing
            // now can never persist credentials that don't work.
            //
            // Review round 2, Important 2: the return value used to be
            // discarded. provisioning.h documents false as "the flash
            // write failed, state deliberately left PROV_PORTAL" -- the
            // one outcome that return exists to report. Discarding it and
            // unconditionally clearing last_error made a flash-write
            // failure loop portal -> submit -> associate -> save-fail ->
            // portal forever with the form showing no error at all, which
            // looks like the submission was silently ignored rather than
            // told "it didn't save, try again".
            wf_logf(WF_INFO, "portal: associated, default route %s",
                    default_route_str());
            if (prov_on_verified_submit(&prov, &submitted)) {
                wf_logf(WF_INFO, "portal: credentials verified and saved");
                last_error = NULL;
            } else {
                last_error = "Could not save configuration, try again";
            }
            continue;
        }

        // PROV_RUNNING: prov.cfg is populated either by prov_init() (a
        // config already on flash) or by prov_on_verified_submit() just
        // above.
        ui_publish(DS_WIFI, "Connecting", prov.cfg.ssid, -1);
        int err = net_radio_sta_connect(prov.cfg.ssid, prov.cfg.pass, 15000);
        if (err != PICO_OK) {
            // prov_on_assoc_result(p, false) is the only call in this
            // loop that may move `state`: three consecutive failures
            // (PROV_MAX_ASSOC_FAILURES) send it back to PROV_PORTAL, and
            // the top of this loop picks that up on the next iteration.
            wf_logf(WF_WARN, "assoc failed (%d), failure %d of %d", err,
                    prov.assoc_failures + 1, PROV_MAX_ASSOC_FAILURES);
            prov_on_assoc_result(&prov, false);
            // Review round 2, Minor 1: if that was the third failure and
            // the portal just opened, show the same reason a submit-path
            // failure would (spec §6's two-message requirement) -- without
            // this, a boot that never had a chance to submit anything
            // shows a blank form instead of "wrong password"/"network not
            // found". A first or second failure leaves state at
            // PROV_RUNNING, so this is a no-op then.
            if (prov.state == PROV_PORTAL) {
                last_error = assoc_failure_message(err);
            }
            continue;
        }
        // Carried from task 2's review: prov_on_assoc_result(p, true)
        // returns p->state UNCHANGED rather than forcing PROV_RUNNING --
        // that is correct only because this call site is reached
        // exclusively from the PROV_RUNNING branch (this `else`, in
        // effect) above, never from PROV_PORTAL. Do not add another call
        // site to prov_on_assoc_result(true) without preserving that.
        prov_on_assoc_result(&prov, true);
        // Success was previously silent -- only failures logged -- so "did it
        // associate?" could not be answered from the console at all.
        wf_logf(WF_INFO, "associated, default route %s", default_route_str());
        g_ui_bars = rssi_bars(wifi_rssi());
        ui_publish(DS_READY, "No disk", ip_str(), -1);

        // Spec §6.2: SNTP before the first TLS handshake, and the firmware
        // never skips straight to a handshake with an unset clock --
        // transport_tls.c's tls_connect() itself refuses to start one at all
        // while sntp_time_valid() is false. A poll or register attempted
        // before this succeeds just fails at connect() and falls into the
        // same backoff dc_step()/dc_register() already use for any other
        // transient network fault, so no separate SNTP-specific retry loop is
        // needed here -- sntp_sync_blocking() also keeps periodically
        // resyncing in the background for as long as the process runs.
        //
        // The RESULT is logged because discarding it silently is the single
        // most confusing failure this firmware can have: tls_connect()
        // refuses to start a handshake at all while sntp_time_valid() is
        // false, so a board that cannot reach an NTP server does not report a
        // clock problem -- it sits in dc_register()'s backoff loop forever,
        // looking for all the world like TLS or the server is broken. Saying
        // so costs one line. (The call's own contract is unchanged: a failure
        // here is still not fatal, and sntp keeps resyncing in the
        // background.)
        bool clock_ok = sntp_sync_blocking(30000);
        wf_logf(clock_ok ? WF_INFO : WF_WARN, "sntp: %s", clock_ok
                ? "clock set"
                : "NO clock -- TLS will refuse every handshake until it syncs");

        // static, like device_client.c's buffers and for the same reason:
        // this branch can re-run (a later prov_on_pairing_code_rejected()
        // sends control back to PROV_PORTAL and eventually back here), but
        // never concurrently with itself -- holding ~590 bytes of live
        // frame for the ensuing mbedTLS handshake chain is ~590 bytes it
        // does not get.
        static char mac[18];   // "aa:bb:cc:dd:ee:ff" + NUL
        mac_address_string(mac, sizeof mac);

        // Registration (spec §7): load a stored token, or register for one
        // using the pairing code the portal collected (or that was already
        // on flash). Never logs `token` or the pairing code -- see
        // device_client.h.
        static char token[TOKEN_STORE_MAX_LEN + 1];
        bool code_rejected = false;
        // Hoisted out of the `if` only so the outcome can be stated. Which of
        // these two paths a board takes is the first thing worth knowing when
        // registration misbehaves, and it was previously invisible.
        bool have_token = token_store_load(token, sizeof token);
        wf_logf(WF_INFO, "device: %s", have_token
                ? "stored token found, skipping registration"
                : "no stored token, registering with pairing code");
        if (!have_token) {
            // dc_register() needs only a transport + host; it never reads
            // c->token (it deliberately sends no bearer at all), so this
            // throwaway device_client_t's token is irrelevant -- NULL is
            // honest about that, and leaves `reg` in DC_UNPROVISIONED,
            // which is never used for anything but this loop.
            static device_client_t reg;
            dc_init(&reg, tls_transport(), clock_ms, g_server.host, NULL);
            // The override's port and Host header (1.13.0): registration goes to
            // the SAME server the poll client below does. After dc_init, which
            // resets them to 443 and the host.
            dc_set_server(&reg, g_server.port, g_server_hdr);
            dc_register_result_t rr;
            while ((rr = dc_register(&reg, prov.cfg.code, WF_FIRMWARE_VERSION, mac))
                   != DC_REG_OK) {
                if (rr == DC_REG_BAD_CODE) {
                    // Spec D-4b-4: terminal, not retryable -- the code is
                    // single-use with a 10-minute TTL and this one has
                    // already been redeemed or has expired. Back to the
                    // portal for a fresh one rather than hammering
                    // /api/device/register with a code that can never
                    // become valid again.
                    //
                    // Latent, comment-only (review round 2): config_store_
                    // erase() (called from inside this) returns early,
                    // erasing nothing on flash, if disk_is_mounted() --
                    // the same guard token_store_save()/token_store_erase()
                    // use (config_store.c/token_store.c). At THIS call
                    // site nothing has been mounted yet -- registration
                    // runs before the poll loop even starts -- so the
                    // guard cannot fire here. The DC_HALTED path below is
                    // a different story (a disk is very plausibly mounted
                    // by the time a token goes bad in the field); see its
                    // comment for why that one explicitly ejects first.
                    prov_on_pairing_code_rejected(&prov);
                    wf_logf(WF_WARN, "register: pairing code rejected "
                            "(single-use, 10 min TTL) -- back to the portal");
                    last_error = "Invalid or already-used pairing code";
                    code_rejected = true;
                    // DC_REG_BAD_CODE comes from a clean 400, so the socket
                    // was KEPT -- this leaks exactly as the DC_HALTED path
                    // used to, and lands in the portal the same way. The
                    // PROV_PORTAL branch would catch it anyway; it is
                    // released here as well so that "we are done with the
                    // network" and "we let go of it" are the same statement
                    // in the same place.
                    release_kept_connection();
                    break;
                }
                // Edge-triggered by construction: one line per ATTEMPT, and
                // every attempt is separated by the backoff below. Without
                // this the loop is a silent forever-retry -- the shape a
                // missing clock, a DNS failure and an unreachable host all
                // collapse into.
                const uint32_t wait_ms =
                    reg.backoff_ms ? reg.backoff_ms : DC_BACKOFF_FLOOR_MS;
                wf_logf(WF_WARN, "register failed (rr=%d), retrying in %lu ms",
                        (int)rr, (unsigned long)wait_ms);
                // Once per pass of this loop, at the point its network work
                // is done -- not "if the coming sleep looks long". See the
                // note on release_kept_connection() above.
                tls_release_if_unreusable();
                sleep_ms(wait_ms);
            }
            if (code_rejected) continue;   // prov.state is now PROV_PORTAL
            wf_logf(WF_INFO, "register: OK, token stored");
            if (!token_store_load(token, sizeof token)) {
                // dc_register() only ever returns DC_REG_OK after
                // token_store_save() itself succeeded, so this should be
                // unreachable. Halting rather than looping back to
                // register again is deliberate: the pairing code has
                // almost certainly been single-used server-side by the
                // successful attempt above, so retrying would just fail
                // forever. Nothing on this core runs again, so the kept
                // connection goes first -- core0 still has a panel and a log
                // to drive out of the same heap.
                release_kept_connection();
                while (1) tight_loop_contents();
            }
        }

        static device_client_t c;
        dc_init(&c, tls_transport(), clock_ms, g_server.host, token);
        // AFTER dc_init, which zeroes the struct (device_client.h).
        // The override (1.13.0): port, Host header, and what status reports about it.
        dc_set_server(&c, g_server.port, g_server_hdr);
        dc_set_server_report(&c, server_is_custom(&g_server, WEBADF_HOST), g_server.tls == OVR_TLS_NOVERIFY);
        dc_set_observer(&c, ui_observe, NULL);
        // HD spec §5.5: this build can play HD only if the drive-ID responder
        // is in it. After dc_init, which zeroes the struct.
        dc_set_plays_hd(&c, WF_DRIVE_ID != 0);
        dc_set_i2c_scan(&c, &g_i2c_scan);   // what answered on i2c1 at boot ("i2c" in every status report)
        // OLED layouts: the display cursor. dc_init zeroes it; the first entry
        // after boot resumes from the stored record's version, so a layout
        // already on the glass is not fetched again. A re-entry is a re-pair:
        // a new device row, whose cursor starts over -- the rule nfcAck and
        // the firmware instruction ack follow too.
        //
        // Ruling J (review fix): a re-pair also puts the FRESH-board state on
        // the glass and in the store -- this panel type's default layout under
        // version 0. The custom layout on the glass belongs to the old row;
        // left there it would also be re-seeded as that row's ack after a
        // reboot, silently skipping the new row's versions up to it. The panel
        // TYPE is kept: it is the hardware's, not the row's.
        {
            static bool display_seeded = false;
            if (display_seeded) {
                display_publish_fresh("re-paired");
                c.display_ack = 0;
            } else {
                c.display_ack = g_display_boot_ack;
            }
            display_seeded = true;
        }
#if DF1_CAPABLE
        // The DF1 setting's cursor (Phase 3): the stored record's version on
        // the first entry after boot, so a setting already applied is not
        // taken again. A re-entry is a re-pair -- a new device row, whose
        // versions start over -- so 0, as for the display cursor above.
        {
            static bool drive_seeded = false;
            c.drive_ack = drive_seeded ? 0u : g_drive_boot_ack;
            drive_seeded = true;
        }
#endif
        // HANDOFF 4g rule 1: a token chosen per boot, so a rebooted board's seq 1
        // is never mistaken for the previous boot's seq 1.
        static char session[20];
        snprintf(session, sizeof session, "b%08lx%08lx",
                 (unsigned long)get_rand_32(), (unsigned long)get_rand_32());
        static uploader_t up;
        up_init(&up, &c, session, wb_write_gen, wb_last_write_ms);
#if WF_PNET_L2
        // PaulaNET Phase 4: files queued for this board go to Receive on the Amiga, between polls (the one HTTPS
        // connection is shared, like the uploader's). Static: the queue and chunk buffers are 22 KB.
        static amiga_send_t g_send;
        static as_ops_t g_send_ops;
        amiga_tcp_ops(&g_send_ops, &c);
        {
            // Not backed by PSRAM (a board without it): sending stays off rather than writing into nothing.
            const bool psram_ok = psram_check_address(&g_send_queue_buf[sizeof g_send_queue_buf - 1]) &&
                                  psram_check_address(&g_send_chunk_buf[sizeof g_send_chunk_buf - 1]);
            if (!psram_ok) wf_logf(WF_ERR, "send: buffers are not backed by PSRAM -- sending to the Amiga is off");
            as_init(&g_send, &g_send_ops, psram_ok ? g_send_queue_buf : NULL, psram_ok ? g_send_chunk_buf : NULL);
        }
#endif
        dc_set_hold(&c, swap_holds, &up);
        // A waiting tap -- or a write landed since the poll began (HANDOFF
        // 3av) -- cuts a held poll short (spec §4.2 amendment). Set on
        // every entry: dc_init above zeroes `c`, and nfc_ack with it -- a
        // re-paired board is a new device row whose cursor starts over.
        dc_set_poll_interrupt(&c, poll_wake_pending, NULL);
        static reinsert_t reins;
        reinsert_init(&reins);
        wf_logf(WF_INFO, "write-back: session %s", session);
        wf_logf(WF_INFO, "entering poll loop against %s", g_server_hdr);

        // 2b: the update state, shared by the trial below and the updater in
        // the poll loop. Loaded, and on a non-trial boot reconciled, ONCE per
        // boot -- this branch is re-entered after a DC_HALTED re-pair, and the
        // updater's state must survive that. dc_set_fw_report, though, runs
        // on every entry: dc_init above zeroes `c`, pointer included.
        static fw_state_t fst;
        static fwu_t fwu;
        static fwu_ops_t fwu_ops;
        static dc_fw_report_t fw_report;          // static: dc_set_fw_report keeps the pointer
        static bool fw_booted = false;
        // Multi-disk preload gate (spec §4.3). Set on every entry: dc_init
        // above zeroes `c`, and a NULL gate means never preload.
        static preload_gate_t preload_gate;
        preload_gate.up = &up;
        preload_gate.fwu = &fwu;
        dc_set_preload_gate(&c, preload_ok, &preload_gate);
#if DF1_CAPABLE
        // DF1 (spec 2026-10-08 §4): the mode core0 runs and what DF1's buffer
        // takes, and -- R15, in every DF1-capable build, before the first
        // dc_step -- the wait for core0 to let go of a slot before core1
        // writes it. Set on every entry: dc_init above zeroes `c`. The
        // reconcile then makes DF1 match (a re-entry finds no preload: DF1 is
        // ejected).
        dc_set_df1(&c, g_df1_mode, DF1_HOLDS_HD);
        dc_set_df1_quiesce(&c, df1_quiesce_wait, NULL);
        dc_df1_reconcile(&c);
#endif
        if (fw_booted) {
            // Re-entry after a DC_HALTED re-pair: a new token and a new
            // device row, so an instruction the old one received no longer
            // applies. Cancel anything not yet past the point of no return
            // (fwu_on_instruction ignores APPLYING/REBOOTING). Not on the
            // first entry after boot: a boot-time FAILED must be reported.
            fwu_on_instruction(&fwu, NULL, FW_OK);
            fw_report.instruction_ack = 0;   // the new row's cursor starts over
            fw_report.state = fwu_state_text(&fwu);
            fw_report.error = fwu_error_text(&fwu);
            wf_logf(WF_INFO, "fw: re-paired -- any pending update offer is dropped");
        } else {
            fw_booted = true;
            fw_state_load(&fst);                      // zeroed if no record
            fwu_init(&fwu, g_fw_stage, sizeof g_fw_stage);
            if (!fw_rom_trial_boot()) {
                // The ONLY place an OTA's pending record is cleared and
                // installed_sequence advanced (CONFIRMED_LATE): the buy itself
                // happened in fw_rom_boot_early, before PSRAM, and a bought
                // image comes back here as a non-trial boot. REVERTED: the
                // boot ROM ran the old image again -- the new one never proved
                // itself -- and the server hears why as a failed update.
                static char why[FWU_ERROR_MAX + 1];   // static: core1's stack is measured tight
                why[0] = '\0';
                fw_boot_t b = fw_boot_reconcile(&fst, WF_FIRMWARE_VERSION, why, (int)sizeof why);
                if (b != FW_BOOT_CLEAN && !fw_state_save(&fst))
                    wf_logf(WF_ERR, "fw: could not save the reconciled update state");
                if (b == FW_BOOT_CONFIRMED_LATE)
                    wf_logf(WF_INFO, "fw: update to %s confirmed (sequence %lu)",
                            WF_FIRMWARE_VERSION, (unsigned long)fst.installed_sequence);
                if (b == FW_BOOT_REVERTED) { fwu_fail(&fwu, why); wf_logf(WF_WARN, "fw: %s", why); }
            }
            // The capability is declared ONLY by a build that can update
            // itself, on a partitioned board with a working PSRAM stage. An
            // unpartitioned board says nothing (0 = omit), and the server
            // never targets it (2a D1).
            fw_report.update_protocol =
                (g_fw_stage_ok && fw_rom_booted_partition() >= 0) ? DC_UPDATE_PROTOCOL : 0;
            fw_report.state = fwu_state_text(&fwu);
            fw_report.error = fwu_error_text(&fwu);
            wf_logf(WF_INFO, "fw: updateProtocol %d (stage %s, partition %d)",
                    fw_report.update_protocol, g_fw_stage_ok ? "ok" : "MISSING",
                    fw_rom_booted_partition());
        }
        fwu_ops = (fwu_ops_t){ fwu_fetch, fwu_apply, fwu_save, fwu_reboot, &c };
        dc_set_fw_report(&c, &fw_report);
        bool fw_report_owed = true;
        // The reader's presence as last put on the status report (g_nfc_reader),
        // and whether a report is owed because it changed.
        int  nfc_reader_seen = 0;
        bool nfc_report_owed = false;
        // Multi-disk: the preload record moved (dc_preload_t.changed) and no
        // report carrying it has reached the server yet.
        bool preload_report_owed = false;
        // OLED layouts: a display version was handled and no report carrying
        // its displayVersion/displayError has reached the server yet.
        bool display_report_owed = false;

        // 2b trial (spec D8): prove the network works, THEN confirm, THEN poll.
        {
            if (fw_rom_trial_boot()) {
                // Final review I2: the trial RUNS the new version but has not
                // kept it -- the boot ROM reverts it unless this loop
                // confirms. Say so: the server does not count the version as
                // installed while the state is "applying". The confirmed boot
                // (a non-trial boot) reports the updater's own state, null.
                // fw_report is already attached (dc_set_fw_report above), so
                // every heartbeat below carries it.
                fw_report.state = "applying";
                fw_report.error = NULL;
                for (;;) {
                    bool hb = dc_report_status(&c, psram_free_estimate(), wifi_rssi(), NULL,
                                               WF_FIRMWARE_VERSION);
                    fw_trial_in_t tin = { true, &fst, WF_FIRMWARE_VERSION, hb, clock_ms() };
                    const char *why = NULL;
                    fw_trial_action_t a = fw_trial_decide(&tin, &why);
                    if (a == FW_TRIAL_BUY) {
                        // Fix round 4: never buy from here. Calling the ROM buy
                        // on core1 wedged the board twice. Mark this version as
                        // proven and reboot into our own slot; the next boot
                        // buys in fw_rom_boot_early, single-core, before
                        // anything else runs, and comes back as a NON-trial
                        // boot -- where fw_boot_reconcile (CONFIRMED_LATE for
                        // an OTA's pending record, CLEAN for a USB install)
                        // does the bookkeeping fw_trial_after_buy used to do.
                        fw_rom_request_proven_reboot(WF_FIRMWARE_VERSION);
                        for (;;) sleep_ms(1000);
                    }
                    if (a == FW_TRIAL_GIVE_UP) {
                        wf_logf(WF_WARN, "trial: giving up (%s) -- rebooting to revert", why);
                        snprintf(fst.failure, sizeof fst.failure, "%s", why);
                        fw_state_save(&fst);
                        fw_rom_request_reboot(0);
                        for (;;) sleep_ms(1000);
                    }
                    tls_release_if_unreusable();
                    sleep_ms(5000);
                }
            }
        }

        static char last_reported_sha[65] = "";
        static uint32_t last_reported_version = 0;
        uint32_t last_status_ms = clock_ms();

        while (true) {
            // The write cursor's mark for this pass (poll_wake.h), taken FIRST,
            // before any up_has_work() below: a write landing after it is then
            // either seen as work by those checks or cuts this pass's poll
            // short. Taken later -- just before dc_step -- a write landing
            // between a "no work" answer and the mark would wait out the poll.
#if WF_PNET_L2
            pnet_bridge_check();      // re-hooks if the radio side re-added its netif
#endif
            const uint32_t pass_write_mark = g_write_last_ms;
            // Tap-to-mount, first: a tap that cut the last poll short goes out
            // now, ahead of anything else this pass sends. Between requests,
            // never inside one -- the uploader's included (dc_tap's rule).
            nfc_core1_event(&c, &up);
            {
                const int r = g_nfc_reader;
                if (r != nfc_reader_seen) {
                    nfc_reader_seen = r;
                    dc_set_nfc_reader(&c, r == 1 ? "present" : r == 2 ? "absent" : NULL);
                    nfc_report_owed = true;
                }
            }
            // SEL1 telemetry rides every status report (cheap: three stores).
            dc_set_sel1(&c, g_sel1_wired, bus_df1_seen(g_df1_steps));
#if WF_PNET_L2
            // Phase 3: Network mode's readings ride the status report (plan 2026-10-12 ruling 13).
            if (g_df1_mode == DF1_MODE_NET) {
                static dc_net_t net;
                static pnet_bridge_stats_t st;      // static: core1's stack is measured tight
                const uint32_t seen = g_pnet_status_last_ms;
                pnet_bridge_stats(&st);
                // HANDOFF 3bu product gap: after a reboot the sorter knows no Amiga until it transmits, so a file for
                // an idle Amiga waited. The server remembers the last address (xfer.ip, plan 2026-10-17 R17).
                if (st.amiga_ip == 0u && c.send_ip_hint != 0u) {
                    pnet_bridge_seed_amiga_ip(c.send_ip_hint);
                    pnet_bridge_stats(&st);
                }
                net.on = true;
                net.driver_seen = seen != 0;
                net.driver_s = seen ? dc_net_driver_age_s(clock_ms(), seen) : 0;
                net.amiga_ip = st.amiga_ip;
                net.frames_in = g_pnet_frames_from;
                net.frames_out = g_pnet_frames_to;
                dc_set_net(&c, &net);
                as_set_inputs(&g_send, true, st.amiga_ip, c.send_version);
            } else {
                dc_set_net(&c, NULL);
                as_set_inputs(&g_send, false, 0, c.send_version);
            }
            // Cheap, every pass (no HTTPS): connect retries, the handshake, pings, Receive's replies, pushing bytes.
            as_tick(&g_send);
            dc_set_send(&c, as_acked_version(&g_send), as_rx(&g_send));
#endif
            g_up_holds = up_holds(&up);   // core0's DF1 store rule (R17)

            // Item 0 (fix round 1, Important): a status report is OWED
            // whenever the mounted disk's identity or version differs from
            // the values last SUCCESSFULLY reported -- checked, and sent if
            // so, before the uploader/poll choice below even runs.
            //
            // Why this has to come first: the server decides an upload's
            // not_mounted/behind verdict purely from the mountedVersion it
            // last heard over this same status channel (HANDOFF 4g), not
            // from anything the poll or the upload itself carries. A report
            // that FAILS to reach the server (transport error, 5xx) used to
            // still be recorded here as sent -- dc_report_status returned
            // void and this loop advanced last_reported_sha/_version
            // regardless. The next dirty-track upload then went out under a
            // version the server had never heard of, got 409 not_mounted,
            // and up_park()'d; parking only clears on a further mount
            // change, never on the plain 60 s heartbeat below (which is
            // exactly this same report, so it would have failed too, for
            // the same reason) -- and while parked, up_holds() is false, so
            // a swap or eject arriving before the next mount change could
            // drop the parked disk's dirty tracks with no trace at all.
            //
            // So: send first, and only believe it worked -- advancing this
            // loop's own bookkeeping -- when dc_report_status says so. A
            // failure while the uploader has work is worth an extra beat of
            // delay (rather than letting up_step race ahead and upload
            // under the still-unreported version): the disk stays held
            // regardless, since up_holds() does not depend on any of this.
            //
            // Review (final), Minor M3: that beat used to be a `continue`,
            // which also skipped the WPROT and panel refresh below for the
            // pass -- so a gate that changed during it (a park, say) waited
            // for the next successful pass to reach the pin. Now the pass
            // runs on with `report_retry` set: no up_step, no dc_step, no
            // heartbeat (no network call beyond the failed report itself),
            // but WPROT and the panel are refreshed, and the 1 s beat is
            // slept at the bottom instead of the top.
            bool report_retry = false;
            bool report_owed = strcmp(c.mounted_sha256, last_reported_sha) != 0 ||
                                c.mounted_version != last_reported_version;
            if (report_owed && c.state != DC_HALTED) {
                if (dc_report_status(&c, psram_free_estimate(), wifi_rssi(), NULL, WF_FIRMWARE_VERSION)) {
                    last_status_ms = clock_ms();
                    fw_report_owed = false;   // the same report carries the fw fields
                    nfc_report_owed = false;  // ...and nfcReader
                    preload_report_owed = false;  // ...and preload
                    display_report_owed = false;  // ...and displayVersion
                    strncpy(last_reported_sha, c.mounted_sha256, sizeof(last_reported_sha) - 1);
                    last_reported_sha[sizeof(last_reported_sha) - 1] = '\0';
                    last_reported_version = c.mounted_version;
                } else if (up_has_work(&up)) {
                    report_retry = true;
                }
            }

            // OLED layouts (spec 2026-10-04 §6): the poll named a display
            // version this board has not handled. Fetched here, between
            // requests, and only with no write-back work waiting (a write goes
            // first) and no owed mount report retrying. Applied or refused, it
            // is acked (dc_display_handled) and reported by Item 4 below.
            // Final review I1: a poll body reset the display cursor to 0 (a
            // re-pair across a reboot: the ack seeded at boot was the OLD
            // row's). Nothing will be fetched, so take the old row's layout
            // off the glass here -- the same fresh-board state the same-boot
            // re-pair publishes -- and report version 0.
            if (dc_display_take_reset_to_default(&c)) {
                display_publish_fresh("cursor reset by the server (re-paired)");
                display_report_owed = true;
            }
            if (!report_retry && c.state != DC_HALTED && c.state != DC_UNPROVISIONED &&
                dc_display_owed(&c) && !up_has_work(&up)) {
                if (display_core1_fetch(&c)) display_report_owed = true;
            }

            dc_state_t s;
            bool polled = false;
            if (report_retry) {
                // Neither the uploader nor the poll this pass: see Item 0.
                s = c.state;
            } else if (up_has_work(&up)) {
                // Writes are pending: no long poll (it would hold the close for up
                // to 25 s), and no swap or eject (dc_set_hold). One request, then
                // round the loop so WPROT, status and the panel stay current.
                if (up_step(&up) == UP_WAITING) sleep_ms(50);
                s = c.state;
            } else if (fwu.phase == FWU_DOWNLOADING || fwu.phase == FWU_APPLYING) {
                // The updater has announced a step ("downloading"/"applying",
                // already reported below) and runs it THIS pass. No poll first:
                // a 25 s long poll would delay it, and before APPLYING it could
                // mount a disk after the idle gate (D6) already passed --
                // fwu_step's APPLYING does not look at `idle` again.
                s = c.state;
#if WF_PNET_L2
            } else if (as_has_work(&g_send)) {
                // A file is moving to the Amiga (Phase 4): one chunk or one queue fetch per pass, no long poll --
                // the single HTTPS connection is needed for the chunks, as for the uploader and the updater above. Nothing moved
                // (waiting on Receive's GO or OK): a short pause instead of spinning.
                if (!as_step(&g_send)) sleep_ms(20);
                s = c.state;
#endif
            } else {
                // This pass's write mark (taken at the top): a write applied
                // since then cuts the poll short.
                g_poll_write_mark = pass_write_mark;
                s = dc_step(&c);
                polled = true;
            }
            // Task 10's contract: a poll cut short by a waiting tap -- or a
            // write that landed during it (HANDOFF 3av) -- decided NOTHING,
            // and `s` is not a result -- DC_BACKOFF included, whose sleep
            // would hold the tap up to 60 s. No state handling at all: round
            // to the top, send the tap or upload the write, poll again.
            if (polled && c.poll_interrupted) continue;
            // The poll asked for a disk change the hold refused (swap_holds):
            // `since` did not advance, so the next poll would be answered at
            // once. Pace it -- the Amiga going idle is seconds away, and a
            // release is then at most this much later.
            if (polled && c.held) sleep_ms(1000);
            // Same for a fetch deferred because core0 had not yet let go of the
            // slot DF1 held (R15): `since` did not advance either, and each
            // redelivery already waited up to 50 ms in df1_quiesce_wait.
            if (polled && c.df1_deferred) sleep_ms(1000);
            // Same for a display version whose fetch is waiting out a failure:
            // the server answers every poll at once while it is owed.
            if (polled && dc_display_owed(&c) && g_display_fetch_failing) sleep_ms(1000);

#if DF1_CAPABLE
            // The DF1 setting (Phase 3, D3): a new one from the poll is handed
            // to core0, which applies it live (df1_live.h). Switching OFF:
            // device_client first, so the reconcile ejects DF1 before core0
            // parks it. Switching ON: device_client only AFTER core0 applied
            // it -- a disk the reconcile published to a DF1 core0 still had
            // off would be acknowledged by core0 and never mounted.
            //
            // The ack (driveAck, what makes the web app say "Set on the
            // board") follows core0's apply, never just the handoff. core0
            // turns in ~1 ms; 50 ms covers anything but a flash write (~45
            // ms of lockout) plus a slow pass. Not applied by then: NOT
            // acked -- the server re-sends the setting on the next poll (its
            // seq is still above driveAck), the handoff is repeated (an
            // idempotent re-apply), and that pass acks. A false "set" would
            // be believed; a late one costs a poll.
            {
                uint32_t seq;
                df1_mode_t mode;
                if (dc_drive_take(&c, &seq, &mode)) {
                    if (mode == DF1_MODE_OFF) {
                        dc_set_df1(&c, DF1_MODE_OFF, DF1_HOLDS_HD);
                        dc_df1_reconcile(&c);
                    }
                    g_drive_req_version = seq;
                    g_df1_req_mode = (uint8_t)mode;
                    __dmb();                 // mode and version before the seq names them
                    const uint32_t want = g_df1_req_seq + 1u;
                    g_df1_req_seq = want;
                    for (int i = 0; i < 50 && g_df1_applied_seq != want; i++) sleep_ms(1);
                    if (g_df1_applied_seq == want) {
                        if (mode != DF1_MODE_OFF) {
                            dc_set_df1(&c, mode, DF1_HOLDS_HD);   // Next or Network: its own rules (B3)
                            dc_df1_reconcile(&c);
                        }
                        dc_drive_handled(&c, seq);   // handled = applied live (the store may lag)
                        wf_logf(WF_INFO, "df1: setting %lu -> %s (the Amiga sees the change at its next reset)",
                                (unsigned long)seq, mode == DF1_MODE_OFF ? "off, parked" : df1_mode_name(mode));
                    } else {
                        wf_logf(WF_WARN, "df1: setting %lu not applied by core0 within 50 ms -- not acked, retried on the next poll",
                                (unsigned long)seq);
                        // An OFF already told device_client "off" above. Put back
                        // what core0 runs now, so the poll's mode compare
                        // (dc_take_second_drive, I1) still owes the setting
                        // when the seq alone would not (ack == seq after a re-pair).
                        dc_set_df1(&c, g_df1_mode, DF1_HOLDS_HD);
                        sleep_ms(1000);   // the server answers at once while it is owed
                    }
                }
            }
#endif

#if WF_FW_DEBUG
            // Fix round 3, bench-only: a minimal USB-serial command that
            // deliberately reproduces the nested-flash_safe_execute wedge the
            // bench hit, to prove the watchdog now resets the board instead
            // of hanging forever (see fw_rom_watchdog_start's
            // pause_on_debug=false, and fw_rom_debug_wedge's own comment).
            // Never built into a release -- WF_FW_DEBUG defaults OFF, and
            // the publish script refuses an image built with it on. Polled
            // non-blockingly so it costs nothing when nothing is typed.
            //
            // Task 11 (spec 8.5/8.6), the same single reader: "fwdbg {json}"
            // hands a crafted update object to the SAME parse -> check -> fwu
            // path a real poll's instruction takes (the block after the poll
            // below). c.fw_instruction_version is left alone, so the ack
            // reported is still the real server's. The string "fwdbg" is what
            // the publish script refuses to ship.
            // Read AFTER the poll: a 200 poll body rewrites c.fw_offer_present
            // (dc_take_fw_fields), which would turn an offer injected before
            // it into a "cancel" in the block below.
            {
                static char dbg_buf[DC_FW_UPDATE_JSON_BYTES + 8];
                static int  dbg_len = 0;
                int ch;
                while ((ch = getchar_timeout_us(0)) != PICO_ERROR_TIMEOUT) {
                    if (ch == '\n' || ch == '\r') {
                        dbg_buf[dbg_len] = '\0';
                        if (strcmp(dbg_buf, "fwdbg-wdtest") == 0) {
                            wf_logf(WF_WARN, "fwdbg: wedging core1 inside flash_safe_execute -- "
                                              "the watchdog must reset within 8 s");
                            fw_rom_debug_wedge();
                        } else if (strncmp(dbg_buf, "fwdbg ", 6) == 0) {
                            if (c.fw_instruction_new) {
                                // A real instruction arrived this pass: never
                                // overwrite its offer under the cursor it acks.
                                wf_logf(WF_WARN, "fwdbg: a real instruction is pending -- injection refused");
                            } else if (strlen(dbg_buf + 6) >= sizeof c.fw_update_json) {
                                wf_logf(WF_WARN, "fwdbg: offer too long -- ignored");
                            } else {
                                snprintf(c.fw_update_json, sizeof c.fw_update_json, "%s", dbg_buf + 6);
                                c.fw_offer_present = true;
                                c.fw_instruction_new = true;
                                // A boot-time sync leaves this set; the
                                // injection is an offer, never a sync.
                                c.fw_instruction_is_sync = false;
                                c.fw_offer_malformed = false;
                                wf_logf(WF_WARN, "fwdbg: injected an offer");
                            }
                        }
                        dbg_len = 0;
                    } else if (dbg_len + 1 < (int)sizeof dbg_buf) {
                        dbg_buf[dbg_len++] = (char)ch;
                    } else {
                        dbg_len = 0;   // overflow: drop the partial line and resync
                    }
                }
            }
#endif
            // 2b: a new update instruction (a real poll's, or -- bench only --
            // fwdbg's), then one step of the updater. Its ack must reach the
            // server, or the server's poll keeps answering with it.
            if (c.fw_instruction_new) {
                c.fw_instruction_new = false;
                fw_report.instruction_ack = c.fw_instruction_version;
                if (c.fw_instruction_is_sync) {
                    // The first cursor after dc_init with no update: the
                    // server's normal echo (device_client.h). Ack it, but it
                    // is NOT a cancel -- a boot-time "failed" (reverted, or a
                    // trial that gave up) must survive to be reported (D8).
                    wf_logf(WF_INFO, "fw: instruction cursor %lu (sync)",
                            (unsigned long)c.fw_instruction_version);
                } else if (c.fw_offer_malformed) {
                    // Final review m2: an `update` that could not be lifted
                    // (too large, say). The cursor is acked above; the
                    // instruction is refused, never read as a cancel.
                    wf_logf(WF_WARN, "fw: malformed update instruction %lu",
                            (unsigned long)c.fw_instruction_version);
                    fwu_refuse(&fwu, "refused: malformed update instruction");
                } else if (c.fw_offer_present && fw_report.update_protocol == 0) {
                    // Never stage into a g_fw_stage PSRAM does not back, or
                    // flash an unpartitioned board. The server should never
                    // target one (2a D1); refuse if it somehow does.
                    fwu_refuse(&fwu, "refused: this board cannot update");
                    wf_logf(WF_WARN, "fw: offer refused -- this board cannot update");
                } else if (c.fw_offer_present) {
                    static fw_offer_t o;   // static: ~300 bytes, off core1's measured stack
                    if (fw_offer_parse(c.fw_update_json, &o)) {
                        fw_verdict_t v = fw_check_offer(&o, fst.installed_sequence);
                        wf_logf(v == FW_OK ? WF_INFO : WF_WARN, "fw: offered %s (seq %lu): %s",
                                o.version, (unsigned long)o.sequence, fw_verdict_text(v));
                        fwu_on_instruction(&fwu, &o, v);
                    } else {
                        wf_logf(WF_WARN, "fw: malformed update instruction %lu",
                                (unsigned long)c.fw_instruction_version);
                        fwu_refuse(&fwu, "refused: malformed update instruction");
                    }
                } else {
                    wf_logf(WF_INFO, "fw: instruction %lu carries no update (cancelled)",
                            (unsigned long)c.fw_instruction_version);
                    fwu_on_instruction(&fwu, NULL, FW_OK);
                }
                fw_report_owed = true;
            }
            // Tap-to-mount: a write request (or its withdrawal) came with the
            // poll. Handed to core0, which owns the reader, and acked.
            if (c.nfc_write_new) {
                wf_logf(WF_INFO, "nfc: write request %lu: %s", (unsigned long)c.nfc_write_seq,
                        c.nfc_write_next ? "Next-disk card"
                        : c.nfc_write_disk_id[0] ? c.nfc_write_disk_id : "withdrawn");
                nfc_core1_write_request(&c);
            }
            {
                // D6: nothing mounted, no unsent writes, motor off. The
                // published slot is checked too -- the same predicate
                // fw_state_save refuses on -- so the gate and the pending
                // record's write can never disagree.
                //
                // Final review m1: and no state report owed. The instruction's
                // ack and the updater's last state must have LANDED before
                // the flash write starts -- otherwise the server can still be
                // re-sending an instruction the board is already acting on.
                //
                // Multi-disk spec §6: a preload in progress is not idle (a
                // finished one is). dc_preload_step runs on this core and
                // clears `loading` before it returns, so this reads false
                // here today; it is the stated rule, kept so a preload that
                // ever spans passes cannot start a flash write under it.
                // Each input read once, so the diagnostic line below prints
                // exactly what the gate decided on (OTA stall, 2026-10-09).
                const bool gate_mounted = c.mounted_sha256[0] != '\0';
                const int  gate_slot    = psram_active_slot();
                const bool gate_upw     = up_has_work(&up);
                const bool gate_motor   = g_motor_on;
                const bool gate_owed    = fw_report_owed;
                const bool gate_preload = c.preload.loading;
                bool idle = !gate_mounted && gate_slot == SLOT_NONE && !gate_upw && !gate_motor && !gate_owed &&
                            !gate_preload;
#if WF_PNET_L2
                {
                    // Network mode's idle (plan 2026-10-11 ruling 12): cylinder 77 quiet for 10 s and
                    // nothing queued for the radio, on top of everything above.
                    const bool tx_pending = pnet_ring_count(&g_pnet_tx) != 0;
                    const bool quiet = pnet_ota_quiet(clock_ms(), g_pnet_last_ms, tx_pending);
                    static bool held_logged;
                    if (!quiet && idle && fwu.phase == FWU_STAGED && !held_logged) {
                        wf_logf(WF_INFO, "fw: update held: cylinder 77 busy (%lu ms ago, %s)",
                                (unsigned long)(clock_ms() - g_pnet_last_ms),
                                tx_pending ? "frames queued" : "none queued");
                        held_logged = true;
                    }
                    if (quiet) held_logged = false;
                    if (!quiet) idle = false;
                }
#endif
                if (fwu_step(&fwu, &fwu_ops, &fst, idle, clock_ms())) {
                    const char *st = fwu_state_text(&fwu);
                    const char *er = fwu_error_text(&fwu);
                    // STAGED reports "queued" to the server (fwu_state_text),
                    // which made a finished download look like a retry in the
                    // log. Say which it is; the server's word is unchanged.
                    wf_logf(er ? WF_WARN : WF_INFO, "fw: %s%s%s%s", st ? st : "idle",
                            fwu.phase == FWU_STAGED ? " (staged: downloaded and verified, waiting for idle)" : "",
                            er ? " -- " : "", er ? er : "");
                    fw_report_owed = true;
                }
                {
                    const fwu_diag_in_t din = {
                        fwu.phase, fwu.retry_at_ms, fwu.backoff_ms, gate_mounted, gate_slot, gate_upw,
                        gate_motor, gate_owed, gate_preload, idle, (int)c.state,
                    };
                    fwu_diag_tick(&din, clock_ms());
                }
                fw_report.state = fwu_state_text(&fwu);
                fw_report.error = fwu_error_text(&fwu);
                if (fwu.phase == FWU_REBOOTING) {
                    // The other slot is written and the pending record saved;
                    // core0's fw_rom_service performs the reboot (M9). One
                    // last report (best effort -- core0 may reset first; the
                    // "applying" before the flash write already went out), then stop.
                    dc_report_status(&c, psram_free_estimate(), wifi_rssi(), NULL, WF_FIRMWARE_VERSION);
                    for (;;) sleep_ms(1000);
                }
            }

            // Item 1: the drive may only ever report a disk once an image is
            // genuinely resident and published -- dc_step only reaches here
            // (mounted_sha256 non-empty) after a real fetch-and-verify or an
            // already-mounted no-op (dc_handle_poll_body), never as a boot-time
            // assumption. `mounted` here only feeds WPROT (item 3) below --
            // review round 1, Important I-1: dskchg_image_inserted()/ejected()
            // used to be called from THIS core, racing core0's gpio_isr/
            // dskchg_poll against dskchg.c's plain, unsynchronized `st` (a
            // pattern that was harmless when it fired exactly once at boot,
            // but became a real race once this loop could call it repeatedly
            // at arbitrary times). That signalling now lives entirely on core0
            // -- see main()'s track_cache_check_swap() call below -- so
            // dskchg.c stays single-threaded.
            bool mounted = c.mounted_sha256[0] != '\0';

            // Item 3: WPROT. Nothing mounted -> nothing to write to regardless
            // of the server's flag; a mounted disk's writeProtected flows
            // through untouched; and the uploader forces this true after a
            // refused write (409 write_protected) and while it is parked,
            // both until the mount changes (up_forces_wprot), so a write
            // already rejected server-side can never be retried as though it
            // had been accepted, and a write made while parked is refused at
            // the drive rather than kept on a disk the poll may replace.
            // Only main()'s core0 loop ever set WPROT before this (a fixed
            // boot-time default); this is now the only place that updates it
            // afterward.
            bool up_forced = up_forces_wprot(&up);
            // HD writes spec §4.5: an HD disk follows the same three gates as
            // DD. (1.4.x held WPROT for HD whatever the server sent.)
            bool wprot = write_back_wprot(mounted, c.mounted_write_protected, up_forced);
            bus_out_set(PIN_WPROT, wprot);
            // The pin is set first, THEN the change is announced: the Amiga
            // must read the new state when it looks.
            if (reinsert_on_wprot(&reins, mounted, c.mounted_disk_id, wprot)) {
                g_reinsert_raised_ms = clock_ms();
                g_reinsert_req = true;
                wf_logf(WF_INFO, "wprot: changed on the mounted disk -- announcing a disk change");
            }
            /*
             * Say so when it CHANGES, with the reason.
             *
             * Added after a write test that produced nothing: WGATE never
             * fired, and working out why meant inferring the pin's state from
             * the absence of an event. THREE separate gates force WPROT --
             * no disk, the server's flag and the uploader (up_forces_wprot:
             * after a refused write, or while parked) -- and none folds into
             * another, so each is its own field below. Without them the
             * reasons were indistinguishable from the log. A gate nobody can
             * observe is a gate nobody can debug.
             */
            static int last_wprot = -1;
            if ((int)wprot != last_wprot) {
                last_wprot = (int)wprot;
                wf_logf(WF_INFO, "wprot: %s (mounted=%s server=%s uploader=%s)",
                        wprot ? "ASSERTED -- the Amiga cannot write" : "RELEASED -- the Amiga may write",
                        mounted ? "yes" : "no",
                        mounted ? (c.mounted_write_protected ? "protected" : "writable") : "n/a",
                        up_forced ? "forced" : "ok");
            }
            // The panel's pencil, from the same value and at the same moment
            // -- lit exactly when the Amiga may actually write, which now
            // also means those writes are on their way to the server via
            // core1's uploader, not merely tolerated on the board alone.
            g_ui_writable = !wprot;
            switch (up_sync(&up)) {
            case UP_SYNCED:  g_ui_sync = DISP_SYNC_SYNCED;  break;
            case UP_PENDING: g_ui_sync = DISP_SYNC_PENDING; break;
            case UP_OFFLINE: g_ui_sync = DISP_SYNC_OFFLINE; break;
            default:         g_ui_sync = DISP_SYNC_SYNCED;  break;
            }

            // Item 4: the status heartbeat. ~60s (DC_STATUS_PERIOD_MS) or
            // immediately on a mount/swap/eject (spec §4.3, §10) -- tracked by
            // the mounted disk's identity (sha256) and version, though Item 0
            // above already sends and records a change-triggered report as
            // soon as one is owed, before the uploader/poll choice even runs;
            // what is left here to trigger on disk_changed/version_changed is
            // only the case where dc_step()/up_step() itself just moved
            // c.mounted_sha256/mounted_version further during THIS same pass
            // -- otherwise this is just the plain 60s timer.
            // Review (final), Minor 5: not while halted. DC_HALTED means a 401
            // (or a 404 device row) -- the bearer is dead everywhere it
            // appears, and /api/device/status uses the same one, so every
            // heartbeat from here on until this loop notices (see the
            // DC_HALTED case below, item 5) would otherwise be a guaranteed
            // 401 against a known-dead token. dc_report_status's own 401
            // handling would just re-set the state it is already in, so
            // there is no reason to send it even the one time before this
            // loop reacts.
#if WF_PNET_L2
            // One sample serves the bars and Phase 2's cylinder-76 RSSI (one radio-bus query a heartbeat).
            const int hb_rssi = wifi_rssi();
            g_ui_bars = rssi_bars(hb_rssi);
            g_pnet_rssi = (int16_t)hb_rssi;
#else
            g_ui_bars = rssi_bars(wifi_rssi());
#endif

            uint32_t now = clock_ms();
            bool disk_changed = strcmp(c.mounted_sha256, last_reported_sha) != 0;
            bool version_changed = c.mounted_version != last_reported_version;
            // Fix round 1: only advance the bookkeeping below when the send
            // actually succeeded (dc_report_status now returns whether it
            // did) -- see Item 0's comment for what a false positive here
            // used to cost.
            // Not on a report_retry pass (M3): Item 0's report just failed,
            // and sending the same report again here would double it.
            // A preload report owed from an earlier pass (see the preload
            // below) rides here too -- but never ahead of a waiting tap.
            if (!report_retry && s != DC_HALTED && (disk_changed || version_changed || fw_report_owed ||
                                    dc_sel1_owed(&c) || dc_drive_report_owed(&c) || dc_net_owed(&c) || nfc_report_owed || display_report_owed ||
                                    (preload_report_owed && !nfc_event_pending(NULL)) ||
                                    (now - last_status_ms) >= DC_STATUS_PERIOD_MS)) {
                if (dc_report_status(&c, psram_free_estimate(), wifi_rssi(), NULL, WF_FIRMWARE_VERSION)) {
                    last_status_ms = now;
                    fw_report_owed = false;
                    nfc_report_owed = false;
                    preload_report_owed = false;   // every report carries `preload`
                    display_report_owed = false;   // ...and displayVersion
                    strncpy(last_reported_sha, c.mounted_sha256, sizeof(last_reported_sha) - 1);
                    last_reported_sha[sizeof(last_reported_sha) - 1] = '\0';
                    last_reported_version = c.mounted_version;
                }
            }

            // Multi-disk preload (spec §4.3): at most once per dc_step, and
            // only after one that really polled and came back idle -- not cut
            // short by a tap (that `continue`d above), not skipped for the
            // uploader or the updater (`polled`), and not on a report-retry
            // pass (which never polls). Nothing NFC may be waiting either: a
            // tap, a write result, a write request, or a write report owed --
            // a preload is a whole-disk fetch, seconds long, and every one of
            // those is answered first; a tap -- or a write (HANDOFF 3av) --
            // that arrives DURING it cuts the
            // transfer short (dc_preload_step installs the poll-interrupt:
            // no record, no backoff, `s` untouched, and the pass rounds to
            // the top where nfc_core1_event sends the tap -- final review I1).
            // The gate (preload_ok) refuses on unsent writes, a held swap and
            // a firmware update.
            //
            // Final review C1: this runs AFTER Items 3 and 4, never before.
            // A pass whose dc_step just published a swap has, by here, already
            // driven WPROT for the NEW disk (Item 3) and told the server about
            // it (Item 4) -- core0 raised CHNG the moment the slot changed, so
            // the Amiga may read the pin at once, and a ~5 s preload ahead of
            // Item 3 left it showing the PREVIOUS disk's protection all that
            // time (reinsert_on_wprot announces a flip only within one disk
            // id, so nothing corrected it). And not at all while the mount
            // is still unreported (Item 4's send failed): the server judges
            // every upload by the mountedVersion it last heard, so that
            // report comes before any background fetch. Item 0 retries it
            // next pass.
            //
            // Its result replaces `s`, so the chain below treats a preload's
            // DC_BACKOFF or DC_HALTED exactly as it does a poll's.
            const bool mount_reported = strcmp(c.mounted_sha256, last_reported_sha) == 0 &&
                                        c.mounted_version == last_reported_version;
            if (polled && s == DC_IDLE_POLL && mount_reported && !c.nfc_write_new &&
                !nfc_event_pending(NULL) && !g_nfc_report.owed) {
                // DF1 any disk (spec 2026-10-14 §5, plan ruling 8): the disk mounted into DF1 first -- someone
                // asked for it -- then DF0's next disk. At most one background fetch per pass; an interrupted pick
                // rounds to the top like an interrupted preload (the tap goes first).
                if (dc_df1_pick_step(&c)) s = c.state;
                else if (!c.df1_pick.interrupted && dc_preload_step(&c)) s = c.state;
                if (c.preload.changed || c.df1_pick.changed) {
                    // Verified, or a record dropped: the server's copy of `preload` / `df1Sha256` is stale until a
                    // report carries it.
                    c.preload.changed = false;
                    c.df1_pick.changed = false;
                    preload_report_owed = true;
                }
            }
            // ...and say so at once, unless a tap is waiting (it goes first;
            // Item 4 carries the owed report on a later pass). Not after a
            // failed preload that had nothing to drop: nothing reported moved.
            if (preload_report_owed && !report_retry && s != DC_HALTED && c.state != DC_HALTED &&
                !nfc_event_pending(NULL)) {
                if (dc_report_status(&c, psram_free_estimate(), wifi_rssi(), NULL, WF_FIRMWARE_VERSION)) {
                    last_status_ms = clock_ms();
                    fw_report_owed = false;
                    nfc_report_owed = false;
                    preload_report_owed = false;
                    display_report_owed = false;
                    strncpy(last_reported_sha, c.mounted_sha256, sizeof(last_reported_sha) - 1);
                    last_reported_sha[sizeof(last_reported_sha) - 1] = '\0';
                    last_reported_version = c.mounted_version;
                }
            }

            // Item 5: actually honour c.backoff_ms between attempts -- dc_step
            // computes it (device_client.c's dc_enter_backoff) but never
            // sleeps on it itself; this loop is what turns the number into an
            // actual delay. DC_IDLE_POLL needs no extra sleep here: dc_step's
            // own long-poll read already blocked for up to DC_POLL_TIMEOUT_MS
            // server-side. DC_HALTED means the token is dead (401 anywhere);
            // re-provisioning is plan 4b's job, so this just idles rather than
            // hammering a dead token in a tight loop.
            //
            // `polled` gates this: when the loop above skipped dc_step to run
            // the uploader instead, `s` is a snapshot of `c.state` taken
            // without our own network attempt, and up_step() already did its
            // own short wait (UP_WAITING) -- sleeping the FULL backoff on top
            // of that would needlessly delay the next dirty-track POST. Slept
            // in 100 ms steps, breaking out early the moment a write lands
            // and up_has_work(&up) goes true, so a write is never held behind
            // the tail of a poll backoff that no longer matters to it.

            // ONE rule, once per pass, and it is the last thing this pass
            // does with the network. Every way this loop can wait runs
            // through the chain below or falls off its end back to the top,
            // and every one of them is covered by being here:
            //
            //   * the poll backoff, up to 60 s;
            //   * DC_UNPROVISIONED's 60 s idle, which never sends again;
            //   * the 1 s report-retry beat (inside the window, so this is
            //     a no-op there -- correctly, the next act is a request);
            //   * the uploader arm's 50 ms naps, which is the case a
            //     sleep-length guard could never catch: up_backoff() climbs
            //     to 60 s while up_has_work() stays true, so a 5xx on a
            //     track upload (cleanly framed, so the socket was KEPT) held
            //     ~32 KB for the whole minute without ever reaching a sleep
            //     long enough to guard;
            //   * up_step()'s 3 s UP_IDLE_CLOSE_MS quiet window, same shape.
            //
            // A future wait added anywhere in this body is covered too, which
            // the old per-sleep guards could not promise.
            tls_release_if_unreusable();

            if (report_retry) {
                // Item 0's beat (M3): a failed owed report, uploader waiting.
                // DC_HALTED from that same report (a 401) is handled on the
                // next pass, exactly as the old `continue` left it.
                sleep_ms(1000);
            } else if (polled && s == DC_BACKOFF) {
                uint32_t remaining = c.backoff_ms;
                // A tap ends the sleep too: it is answered now ("Tag: offline"
                // if the fault persists), not after up to 60 s of backoff.
                while (remaining > 0 && !up_has_work(&up) && !nfc_event_pending(NULL)) {
                    uint32_t step = remaining < 100 ? remaining : 100;
                    sleep_ms(step);
                    remaining -= step;
                }
            } else if (s == DC_HALTED) {
                // Review round 2, Important 1: DC_HALTED used to be a
                // permanent, unrecoverable strand. This `while (true)`
                // never broke, so once registered the outer state machine
                // (provisioning.h) was unreachable again for the rest of
                // the process's life -- a revoked token or a deleted
                // device row (401/404) idled here at the backoff cap
                // forever, and a power cycle did NOT help: config and
                // token both survive flash, prov_init() lands back in
                // PROV_RUNNING, token_store_load() at the top of this
                // branch succeeds, registration is skipped, and the very
                // first status/poll re-401s straight back into DC_HALTED.
                // Recovery needed a physical reflash for what should be a
                // routine re-pair in the web UI -- and task 8 is docs
                // only, so leaving this for "later" meant never.
                //
                // The fix reuses primitives this task already added:
                // eject whatever is mounted (psram_publish_slot(SLOT_NONE)
                // -- the same call dc_step() itself makes for a normal
                // eject, safe to call from core1) so the config/token
                // erases below cannot be silently refused by their
                // mounted-disk guard (see the prov_on_pairing_code_
                // rejected() comment above -- without this eject, a
                // DC_HALTED reached with a disk mounted, the ordinary
                // case in the field, would make token_store_erase() below
                // a no-op and every subsequent boot would just 401 straight
                // back into DC_HALTED again); then token_store_erase()
                // and break out of this inner loop. Back at the top of
                // the outer PROV_RUNNING branch, token_store_load() now
                // fails, so the registration loop runs again with
                // prov.cfg.code -- the same, already-redeemed pairing
                // code -- which the server reports as
                // invalid_or_used_code (DC_REG_BAD_CODE), landing on
                // prov_on_pairing_code_rejected() and the portal, exactly
                // where a human can supply a fresh pairing code.
                //
                // A dead token can leave dirty tracks with nowhere to go: the
                // uploader (uploader.c) can only push them with a live
                // bearer, and the eject just below discards the board's own
                // copy along with them. Say so, with a count, rather than
                // let a write silently vanish with no trace at all.
                {
                    int dirty = psram_image_dirty_count(psram_active_slot());
                    if (dirty > 0)
                        wf_logf(WF_WARN, "write-back: %d dirty tracks lost (token dead)", dirty);
                }
                psram_publish_slot(SLOT_NONE);
                token_store_erase();
                // The transport may be holding a TLS connection open for a
                // next request that is never coming (keep-alive,
                // transport_tls.c). Breaking out of here without ending it
                // leaks the pcb and ~32 KB of mbedTLS buffers for the rest
                // of this boot, and leaves a socket that can outlive the AP
                // episode the portal is about to start.
                release_kept_connection();
                break;
            } else if (s == DC_UNPROVISIONED) {
                // Review (final), Important 2: DC_UNPROVISIONED gets the same
                // floor as DC_HALTED used to. dc_step returns it immediately
                // without touching the network, so if token_store_load()
                // ever hands back a zero-length token (dc_init reads that
                // as unprovisioned) this loop would otherwise spin core1
                // flat out calling dc_step, dc_report_status and
                // cyw43_wifi_get_rssi forever. This state cannot change
                // from inside this loop (unlike DC_HALTED, above, which
                // now recovers), so idling is the whole correct behaviour.
                // Idling holding a TLS connection is not, and this state
                // never sends another request -- but that is now the per-pass
                // tls_release_if_unreusable() above's job, not a guard of its
                // own here.
                sleep_ms(DC_BACKOFF_CAP_MS);
            }
        }
    }
}

// ---------------------------------------------------------------- serving
// core0's loop: put the track drive d's head is over on drive d's stream, from
// the disk `token` names (DF0: psram_active_token(); DF1: the DF1 word core0
// last acknowledged). `*loaded` is the track drive d streams (-1: none).
//
// R14: track_cache_get_token's buffer is consumed by start_streaming -- which
// copies it -- before this returns, so no other get (the other drive's
// included) can run in between.
static void serve_drive(unsigned d, int32_t token, int *loaded) {
    const int want = want_track[d];
    if (want < 0 || want == *loaded) return;
    uint32_t bits;
    const uint64_t get_t0 = time_us_64();
    const uint8_t *mfm = track_cache_get_token(token, want, &bits);
    // Taken before start_streaming so it times only the get: for an
    // HD track that is the encode (track_cache.c), or a double-buffer
    // hit, which is only faster. The previous track keeps streaming
    // for all of it (start_streaming only aborts it once the new
    // track is in hand).
    const uint32_t get_us = (uint32_t)(time_us_64() - get_t0);
    // `a` carries the drive in bits 8+ (tracks are < 160): DF0's records read
    // as before.
    const uint32_t a = (uint32_t)want | ((uint32_t)d << 8);
    if (mfm && start_streaming(d, mfm, bits)) {
        *loaded = want;
        wf_trace(WF_EV_TRACK_SERVED, a, bits);
        // No LED blip: a SIDE flip re-serves every drive's track, selected or
        // not (activity_led.h). The LED is set by the loop (led_activity.h).
        // Logged AFTER start_streaming, so the logging cost is never
        // on the path to the new stream: say so when an HD get takes
        // longer than any before. The spike's worst was 4.9 ms
        // against a ~15 ms settle budget.
        static uint32_t hd_encode_max_us;
        if (bits == ADF_MFM_HD_TRACK_BITS && get_us > hd_encode_max_us) {
            hd_encode_max_us = get_us;
            wf_logf(WF_INFO, "hd: track %d encoded in %lu us (new max)", want, (unsigned long)get_us);
        }
    } else {
        // Not a cache miss to retry -- psram_image.h is explicit
        // that a track absent from PSRAM is a fault. Worth a record
        // every time it happens: on the Amiga this is a drive that
        // reads some tracks and not others, which looks like bad
        // media unless the log says otherwise. (start_streaming refusing
        // a track too long for the drive's buffer lands here too, its
        // stream stopped: never the previous track under a new head
        // position.)
        //
        // `loaded` latches here for the same reason it does on the
        // hit path, and NOT latching it was a real defect. The
        // condition above is level-triggered, so a miss that left
        // `loaded` alone re-entered this branch on the next 1 ms
        // iteration and traced the same track again, forever.
        // Measured on a rev A2 board 2026-09-10: a freshly booted
        // board with no disk mounted -- want_track == 0 and nothing
        // in PSRAM, which is the DEFAULT state of every board at
        // power-on -- emitted 44,929 TRACK-MISS records in 48
        // seconds (40 KB/s), burying every other event at several
        // thousand to one and defeating the whole point of the log.
        // Latching makes it one record per track change, which is
        // what "every time it happens" was always meant to mean.
        //
        // Not retrying costs nothing: a mount or an eject resets
        // `loaded` to -1 (track_cache_check_swap for DF0, the DF1 word
        // for DF1), so a track that only arrives later is re-attempted then.
        *loaded = want;
        wf_trace(WF_EV_TRACK_MISS, a, 0);
    }
}

#if WF_PNET_LOOP
// ---------------------------------------------------------------- PaulaNET loopback (TEST build)
// Plan docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md. PaulaNET protocol:
// Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET, used with permission.
//
// DF1's cylinder 77 is not disk data while g_pnet_on (Network mode; in the echo TEST build Next disk too). The
// marker exists only in the echo TEST build. Side 0 takes the Amiga's batch (gpio_isr arms
// a raw capture on SEL1); side 1 streams the echo of its frames in PaulaNET's framing. All of it
// runs on core0 -- the STEP and WGATE interrupts and this loop -- so nothing is shared with core1.
// The decoded frames live in PSRAM, in two halves: a batch that fails to parse never touches the
// echo being served. The echo track is built into DF1's own stream buffer, which nothing else
// uses while the head is on cylinder 77, so the loopback adds no SRAM buffer at all.
//
// The marker tells scripts/firmware-release.ts (src/lib/firmware-manifest.ts) that this image is
// a TEST build; the boot banner reads it, which keeps it in the image.
#if PNET_ECHO_BUILD
const char wf_pnet_loop_marker[] = "wf-pnet-loop-test";
#endif
static pnet_loop_t g_pnet;                       // core0 only
#if WF_PNET_L2
// Phase 1: the counters for real frames (pnet_link.h). g_pnet keeps the capture counts (rx, bad[]).
static pnet_link_t g_link;
// Phase 2: cylinder-76 status loops streamed, and reads of it before core1 had the MAC (ruling 10).
static uint32_t g_pnet_status_serves, g_pnet_status_early;
// The heap low-water, sampled every loop pass (the 5 s heap: line can miss a dip; ruling 13).
static uint32_t    g_pnet_heap_low = UINT32_MAX;
// PaulaNET LZ4 (spec 2026-10-18 §5). All of it is PSRAM: SRAM has no room left (the heap low-water already sits at
// its 20,480 B floor, HANDOFF 3bv; ruling F2: .bss may not grow), so g_lz4 is zeroed at boot after its PSRAM check,
// never by crt0. Its own statics, so the RX window and scratch never overlap the capture they decode from
// (flux_capture.c's mfm_buf, SRAM) -- pnet_lz4_decode's src must not overlap its window.
static __uninitialized_psram("lz4txw") uint8_t  g_lz4_tx_win[PNET_LZ4_WINDOW];         // the batch out, back to back
static __uninitialized_psram("lz4txb") uint8_t  g_lz4_tx_blk[PNET_LZ4_WINDOW];         // ...its LZ4 blocks
static __uninitialized_psram("lz4tab") uint16_t g_lz4_table[PNET_LZ4_TABLE_ENTRIES];   // the 8 KB hash table (zeroed at boot)
static __uninitialized_psram("lz4rxw") uint8_t  g_lz4_rx_win[PNET_LZ4_WINDOW];         // the Amiga's batch, decoded
static __uninitialized_psram("lz4rxs") uint8_t  g_lz4_rx_scratch[PNET_LZ4_BLOCK_MAX];  // an MFM-wrapped block
typedef struct {
    pnet_pack_t pack;                        // the batch out: its frames, and how each goes
    bool        pack_lz4;                    // ...packed with LZ4 on
    bool        ok;                          // every buffer above is backed by PSRAM (boot); else LZ4 is off both ways
    uint32_t    out_lz4, out_mfm, wire, saved; // new batches: frames by encoding, payload bytes, bytes LZ4 saved
    uint32_t    us_max, us_sum, us_n;          // pnet_pack per new batch, this 5 s window
    uint32_t    budget, unencoded;             // new batches that spent PNET_PACK_LZ4_BUDGET_US; their frames sent
                                               // MFM unencoded (review I1)
    uint32_t    dus_max, dus_sum, dus_n;       // the take of a new LZ4-asking batch from the Amiga, this 5 s window
} pnet_lz4_state_t;
static __uninitialized_psram("lz4st") pnet_lz4_state_t g_lz4;
// time_us_32: the LZ4 budget's clock (review I1; pnet_pack.h), as the prep and build timings below.
static const pnet_pack_mem_t g_lz4_mem = { g_lz4_tx_win, g_lz4_tx_blk, g_lz4_table, PNET_LZ4_TABLE_ENTRIES,
                                           time_us_32 };
// g_lz4 is backed by PSRAM: asked every time rather than kept in a flag, since a flag would be SRAM (ruling F2), and
// an unbacked PSRAM address bus-faults. When it is not, nothing reads g_lz4.ok (ruling F9): LZ4 is off and byte 155
// is 0 -- though L2 is broken anyway then, its rings being PSRAM too (pnet_bridge_init logs that).
static bool pnet_lz4_backed(void) { return psram_check_address((uint8_t *)&g_lz4 + sizeof g_lz4 - 1u); }
static bool pnet_lz4_on(void) { return pnet_lz4_backed() && g_lz4.ok; }
// The buffer limit: a batch's bytes on the wire within DF1's buffer (pnet_link_fit also holds its payload to
// PNET_TO_AMIGA_MAX_PAYLOAD), with the lead-in this build sends (pnet_frame.c).
#define PNET_BATCH_CAP (sizeof track_words1 - (PNET_TX_LEAD_BYTES - PNET_LEAD_BYTES))
#define PNET_CTR g_link
#else
#define PNET_CTR g_pnet
#endif
#if !WF_PNET_L2
static uint8_t     g_pnet_half;                  // the half of g_pnet_echo the echo is in
#endif
static __uninitialized_psram("pnetecho") uint8_t g_pnet_echo[2][PNET_ECHO_BYTES];
// One 5 s window of timings, for pnet_log_summary.
static uint32_t g_pnet_dec_max, g_pnet_dec_sum, g_pnet_decs, g_pnet_ready_max;
static uint32_t g_pnet_build_max, g_pnet_build_sum, g_pnet_builds, g_pnet_backlog_max;
static bool     g_pnet_reject_logged;            // one detailed refusal per window
// Word 0 (arm -> first edge: the WGATE arm's latency, bench fix 3) over one 5 s window, for the
// accepted [0] and the refused [1] captures, and how many accepted ones synced by implication.
// Each lead saturates at 9,999,999 ns, so the line stays inside WF_LOG_MSG.
#define PNET_LEAD_SAT 9999999u
typedef struct { uint32_t min, max, n; uint64_t sum; } pnet_lead_t;
static pnet_lead_t g_pnet_lead[2] = {{UINT32_MAX, 0, 0, 0}, {UINT32_MAX, 0, 0, 0}};
static uint32_t    g_pnet_implied;
// The echo's stream restarts over one 5 s window, by cause: the head came back to side 1 from
// side 0 (side), a commit rebuilt it in place (commit), anything else (other: a step onto the
// cylinder, a remount). noop: restarts whose INDEX was already asserted, so no new edge. And the
// max us from the SIDE edge to the restart's INDEX, side returns only. g_pnet_rst_commit: the
// loop's commit asked for this restart.
enum { PNET_RST_SIDE, PNET_RST_COMMIT, PNET_RST_OTHER, PNET_RST_N };
static uint32_t g_pnet_rst[PNET_RST_N], g_pnet_rst_noop, g_pnet_side_idx_max;
// Phase 2 (Task 1): the earliest SIDE edge -> start (us) this window, and whether the start pending or
// streaming is a side return's (pnet_go measures only those). The loop and the start alarm write
// these on the same core; a torn window statistic is the worst a race can do.
static uint32_t      g_pnet_side_idx_min = UINT32_MAX;
static volatile bool g_pnet_go_side;
#if PNET_SIDE_DELAY_US
// Side-1 starts this window: from the alarm on time / at once because the loop came after the due time.
static uint32_t      g_pnet_go_delayed, g_pnet_go_late, g_pnet_go_short, g_pnet_go_skipped;
// Set by the start alarm when it skips (side 1 left the out-track); the loop turns it into loaded1 = -1 so a
// side return that follows is served as a fresh start instead of seen as "already loaded" and left silent.
static volatile bool g_pnet_go_rearm;
#endif
static bool     g_pnet_rst_commit;

static void pnet_lead_add(pnet_lead_t *l, uint32_t ns) {
    if (ns > PNET_LEAD_SAT) ns = PNET_LEAD_SAT;
    if (ns < l->min) l->min = ns;
    if (ns > l->max) l->max = ns;
    l->sum += ns;
    l->n++;
}

static void pnet_reject(pnet_err_t e, const flux_capture_raw_t *cap) {
    g_pnet.bad[e]++;
    // A pre-armed capture's word 0 is idle time, not arm latency: the lead stats are the ISR's.
    if (!cap->prearmed) pnet_lead_add(&g_pnet_lead[1], cap->lead_ns);
    if (g_pnet_reject_logged) return;
    g_pnet_reject_logged = true;
    // Two lines, each inside WF_LOG_MSG at full field widths. +imp: the sync was implied; +ovf: the
    // buffer overflowed. Then lead (word 0, arm to first edge), hunt (intervals hunted through) and
    // sync (the interval that ended the hunt, or the implied sync's first data interval): a NOSYNC
    // with hunt w-1 never met a sync; a ~31 us sync just outside the window is the pulse width.
    // +pre: the capture was pre-armed, so its lead is idle time, not arm latency.
    wf_logf(WF_WARN, "pnet: refused %s: %luB w %lu oor %lu%s%s%s",
            pnet_err_text(e), (unsigned long)cap->nbytes, (unsigned long)cap->words,
            (unsigned long)cap->out_of_range, cap->implied ? " +imp" : "",
            cap->prearmed ? " +pre" : "", cap->overflowed ? " +ovf" : "");
    wf_logf(WF_WARN, "pnet: refused at lead %lu hunt %lu sync %lu pw %ld",
            (unsigned long)cap->lead_ns, (unsigned long)cap->hunt_n,
            (unsigned long)cap->sync_ns, (long)cap->pw_ns);
}

// A finished cylinder-77 write: parse it, and take its frames if the batch is new. Runs before
// DF1 is served in the same pass, so a read of side 1 that follows at once gets this echo.
// True when a batch was committed: the echo (or its counters) changed.
static bool pnet_take_capture(void) {
    flux_capture_raw_t cap;
    if (!flux_capture_take_raw(&cap)) return false;
    pnet_raw_pending = false;
#if WF_PNET_L2
    // Cylinder 77 is busy from the claim on, refused captures included (OTA rule; never 0 = never).
    g_pnet_last_ms = clock_ms() | 1u;
#endif
    const uint64_t t0 = time_us_64();
    g_pnet.rx++;
    if (cap.max_backlog > g_pnet_backlog_max) g_pnet_backlog_max = cap.max_backlog;
    if (!cap.sync_ok) { pnet_reject(PNET_E_NOSYNC, &cap); return false; }
    // A gap over PNET_RX_MAX_CELLS was clamped: those cells are invented, so nothing is parsed.
    if (cap.out_of_range) { pnet_reject(PNET_E_RANGE, &cap); return false; }
    pnet_hdr_t h;
    pnet_err_t e = pnet_parse_hdr_from_amiga(cap.bytes, cap.nbytes, &h);
    if (e != PNET_OK) { pnet_reject(e, &cap); return false; }
#if WF_PNET_L2
    // Phase 2 (spec 2026-10-11 §3.2): the acknowledgement first (it may free our batch out), then the
    // Amiga's batch -- ALWAYS taken once its header checks out. Its frames are decoded straight into
    // the TX ring's slots while the ring has room; the rest, and a malformed frame with those after it,
    // are dropped and counted (pnet_link.h). No scratch: an RLE batch can decode past any fixed size.
    const unsigned acked = pnet_link_ack(&g_link, &h);
    if (acked) { pnet_ring_drop(&g_pnet_rx, acked); g_pnet_frames_to += acked; }
    const uint32_t queued0 = g_link.queued;
    // LZ4 (spec 2026-10-18 §5): a batch from our driver (0x10) is decoded through the RX window, linked. The take
    // also sets g_link.amiga_lz4, which pnet_prepare_echo reads -- after this ack and this take, so a re-pack it
    // makes (pnet_link_shrink) always follows the ack and the take of the same header.
    const bool lz4 = pnet_lz4_on();
    const uint64_t z0 = time_us_64();
    const pnet_take_t took = pnet_link_take_lz4(&g_link, &h, cap.bytes + PNET_HDR_BYTES, &g_pnet_tx,
                                                lz4 ? g_lz4_rx_win : NULL, g_lz4_rx_scratch);
    if (lz4 && took == PNET_TAKE_NEW && (h.compressed & PNET_DRIVER_LZ4)) {
        const uint32_t dus = (uint32_t)(time_us_64() - z0);   // the bench's PSRAM cost, decoding (Task 3 carry)
        if (dus > g_lz4.dus_max) g_lz4.dus_max = dus;
        g_lz4.dus_sum += dus;
        g_lz4.dus_n++;
    }
    g_pnet_frames_from += g_link.queued - queued0;
#else
    if (pnet_loop_is_new(&g_pnet, &h)) {
        uint16_t lens[PNET_MAX_FRAMES];
        unsigned n = 0;
        e = pnet_parse_frames(cap.bytes + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD,
                              g_pnet_echo[g_pnet_half ^ 1u], PNET_ECHO_BYTES, lens,
                              PNET_MAX_FRAMES, &n);
        if (e != PNET_OK) { pnet_reject(e, &cap); return false; }
        g_pnet_half ^= 1u;
        pnet_loop_commit(&g_pnet, &h, n, lens);
    } else {
        pnet_loop_commit(&g_pnet, &h, 0, NULL);  // a resend: only its acknowledgement counts
    }
#endif
    const uint64_t now = time_us_64();
    const uint32_t dec = (uint32_t)(now - t0), ready = (uint32_t)(now - cap.ended_us);
    if (dec > g_pnet_dec_max) g_pnet_dec_max = dec;
    if (ready > g_pnet_ready_max) g_pnet_ready_max = ready;
    g_pnet_dec_sum += dec;
    g_pnet_decs++;
    if (cap.implied) g_pnet_implied++;
    if (!cap.prearmed) pnet_lead_add(&g_pnet_lead[0], cap.lead_ns);
    return true;
}

// track_words1 holds the latest commit's echo, packed as the DMA reads it (g_pnet_prepared_words
// words). Cleared when anything else fills the buffer: a disk track (serve_drive).
static bool     g_pnet_prepared;
static uint32_t g_pnet_prepared_words;
static uint32_t g_pnet_prep_max, g_pnet_prep_sum, g_pnet_preps;

// Bytes built at w (the wire's order) repacked IN PLACE into the words the DMA reads: safe, since word
// i is written only after bytes 4i..4i+3 are read, and no later word reads a byte before 4(i+1). The
// builders pad to whole words. Returns the word count.
static uint32_t pnet_pack_words(uint32_t *w, size_t bytes) {
    const uint8_t *b = (const uint8_t *)w;
    const uint32_t n = ((uint32_t)bytes + 3u) / 4u;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t v = 0;
        for (int k = 0; k < 4; k++) v = (v << 8) | b[i * 4u + (uint32_t)k];
        w[i] = v;
    }
    return n;
}

// Builds the echo for the latest commit into track_words1 and packs it into words, with DF1's
// stream stopped (the DMA reads that buffer). Measured 2026-10-10 at N=8000: building at the
// SIDE edge took ~3.7 ms, and the Amiga's payload reads found the sync 195-305 bytes in (the
// read's margin is ~184), so the build moves here, to the commit, while the head is on side 0.
static bool pnet_prepare_echo(void) {
    const uint64_t t0 = time_us_64();
    pnet_go_cancel();                            // before echo_live drops: a pending start must not fire into this teardown
    g_pnet_echo_live = false;
    g_pnet_prepared = false;
    stream_stop(1);
#if WF_PNET_L2
    // Phase 1: our batch out, or -- when none is out -- a new one from what is waiting. It stays out, rebuilt
    // unchanged here, until the Amiga acknowledges it (ruling 10; pnet_link.h). LZ4 (spec 2026-10-18 §3, §5): packed
    // by the frames' real sizes, LZ4 only while the Amiga's latest batch asked for it (0x10). The batch out is
    // re-packed only when that changed: without LZ4 it may hold fewer frames (pnet_link_shrink); the rest stay
    // waiting. That happens after the ack and the take of the header that changed it (pnet_take_capture). A swap to
    // Rob's stock driver can lose ONE LZ4 batch (ruling F5): his driver reads before it writes, so the LZ4 batch out
    // may already have been read and acknowledged; the next batch is MFM.
    const bool lz4 = pnet_lz4_on() && g_link.amiga_lz4;
    if (!g_link.backup || g_lz4.pack.n != g_link.nframes || g_lz4.pack_lz4 != lz4) {
        pnet_frame_ref_t in[PNET_MAX_FRAMES];
        unsigned avail = g_link.backup ? g_link.nframes : pnet_ring_count(&g_pnet_rx);
        if (avail > PNET_MAX_FRAMES) avail = PNET_MAX_FRAMES;
        for (unsigned i = 0; i < avail; i++) in[i].data = pnet_ring_peek(&g_pnet_rx, i, &in[i].len);
        const uint64_t p0 = time_us_64();
        pnet_pack(&g_lz4.pack, &g_lz4_mem, lz4, in, avail, PNET_BATCH_CAP);
        const uint32_t pus = (uint32_t)(time_us_64() - p0);
        g_lz4.pack_lz4 = lz4;
        if (g_link.backup) {
            pnet_link_shrink(&g_link, g_lz4.pack.n);
        } else {
            pnet_link_start(&g_link, g_lz4.pack.n);
            if (g_lz4.pack.n) {
                g_lz4.out_lz4 += g_lz4.pack.lz4;
                g_lz4.out_mfm += g_lz4.pack.n - g_lz4.pack.lz4;
                g_lz4.wire += g_lz4.pack.wire;
                g_lz4.saved += g_lz4.pack.saved;
                g_lz4.budget += g_lz4.pack.budget;
                g_lz4.unencoded += g_lz4.pack.unencoded;
                if (pus > g_lz4.us_max) g_lz4.us_max = pus;   // the bench's PSRAM cost, encoding (Task 3 carry)
                g_lz4.us_sum += pus;
                g_lz4.us_n++;
            }
        }
    }
    const uint8_t flags = pnet_ring_count(&g_pnet_rx) > g_link.nframes ? PNET_CANRECEIVE : 0u;
    const unsigned nf = g_link.nframes;
    const uint8_t ack = g_link.last_amiga, pico = g_link.pico;
    // Built as bytes straight into the word buffer, then repacked in place (pnet_pack_words).
    uint8_t *out = (uint8_t *)track_words1;
    const size_t bytes = pnet_build_to_amiga_out(out, sizeof track_words1, ack, pico, flags, g_lz4.pack.f, nf);
#else
    pnet_frame_ref_t f[PNET_MAX_FRAMES];
    const uint8_t *p = g_pnet_echo[g_pnet_half];
    for (unsigned i = 0; i < g_pnet.nframes; i++) {
        f[i].data = p;
        f[i].len = g_pnet.len[i];
        p += g_pnet.len[i];
    }
    const uint8_t flags = 0;
    const unsigned nf = g_pnet.nframes;
    const uint8_t ack = g_pnet.last_amiga, pico = g_pnet.pico;
    // Built as bytes straight into the word buffer, then repacked in place (pnet_pack_words).
    uint8_t *out = (uint8_t *)track_words1;
    const size_t bytes = pnet_build_to_amiga(out, sizeof track_words1, ack, pico, flags, f, nf);
#endif
    if (bytes == 0) {
        wf_logf(WF_ERR, "pnet: an echo of %u frames does not fit DF1's %u B buffer -- not served",
                (unsigned)nf, (unsigned)sizeof track_words1);
        return false;
    }
    const uint32_t nwords = pnet_pack_words(track_words1, bytes);
    g_pnet_prepared_words = nwords;
    g_pnet_prepared = true;
    const uint32_t us = (uint32_t)(time_us_64() - t0);
    if (us > g_pnet_prep_max) g_pnet_prep_max = us;
    g_pnet_prep_sum += us;
    g_pnet_preps++;
    return true;
}

// start_streaming's DMA start for words already packed: DF1's prepared batch (track_words1), or, in L2
// builds, cylinder 76's status loop (g_pnet_status_words, which dma_irq then re-arms from).
static bool pnet_stream_words(const uint32_t *src, uint32_t nwords) {
    stream_t *s = &g_stream[1];
    stream_stop(1);
    if (s->dma < 0 || s->words != track_words1) return false;
    s->prev_revs = s->rev_count;
    s->rev_count = 0;
    s->index_traced = false;
    s->count = nwords;
#if WF_PNET_L2
    g_pnet_status_live = src != track_words1;
#endif
    const uint ch = (uint)s->dma;
    dma_channel_config c = dma_channel_get_default_config(ch);
    channel_config_set_transfer_data_size(&c, DMA_SIZE_32);
    channel_config_set_read_increment(&c, true);
    channel_config_set_write_increment(&c, false);
    channel_config_set_dreq(&c, pio_get_dreq(pio, s->sm, true));
    dma_channel_configure(ch, &c, &pio->txf[s->sm], src, s->count, true);
    dma_channel_set_irq0_enabled(ch, true);
    s->live = true;
    return true;
}

static bool pnet_stream_prepared(void) { return pnet_stream_words(track_words1, g_pnet_prepared_words); }

// INDEX now, as PaulaNET does at the start of every transmission (dma_irq's INDEX is at the wrap). Spike C
// showed moving our INDEX edge does not move the Amiga's read: its start is timed from SIDE (HANDOFF 3bi).
// The pulse is kept short (PNET_INDEX_PULSE_US) all the same. Already asserted: no new edge (noop).
static void pnet_index_now(void) {
    const uint32_t now32 = time_us_32();
    if ((int32_t)(g_pnet_idx_end_us - now32) > 0) g_pnet_rst_noop++;
    g_pnet_idx_end_us = now32 + PNET_INDEX_PULSE_US;
    bus_out_set_drive(1, PIN_INDEX, true);
    add_alarm_in_us(PNET_INDEX_PULSE_US, index_off, (void *)(uintptr_t)1u, true);
}

// Starts DF1's prepared side-1 stream and its INDEX. From the loop (pnet_serve_df1), or from the
// start alarm (pnet_go_due) on the same core.
static void pnet_go(void) {
    if (!pnet_stream_prepared()) return;
    g_pnet_echo_live = true;
#if WF_PNET_L2
    g_pnet_last_ms = clock_ms() | 1u;            // the Amiga is reading cylinder 77 (never 0)
#endif
    pnet_index_now();
    if (g_pnet_go_side) {
        // The restart can precede the SIDE ISR's stamp (negative latency): that is 0, not 4,294 s.
        const int32_t lat = (int32_t)(time_us_32() - g_pnet_side_us);
        const uint32_t l = lat > 0 ? (uint32_t)lat : 0u;
        if (l > g_pnet_side_idx_max) g_pnet_side_idx_max = l;
        if (l < g_pnet_side_idx_min) g_pnet_side_idx_min = l;
    }
}

#if PNET_SIDE_DELAY_US
static int64_t pnet_go_due(alarm_id_t id, void *ud) {
    (void)id;
    (void)ud;
    g_pnet_go_alarm = 0;              // first: pnet_go's own stream_stop(1) must not cancel this alarm
    if (!pnet_go_still_wanted(want_track[1])) {   // side 1 no longer wants the out-track
        g_pnet_go_skipped++;
        g_pnet_go_rearm = true;
        return 0;
    }
    pnet_go();
    g_pnet_go_delayed++;              // counted only when the alarm really started the stream
    return 0;                         // once
}

// Phase 2 (Task 1, spec §3.4). A side-1 start that comes within PNET_SIDE_DELAY_US of the latest SIDE
// edge -- a side return, or a commit landing just after one -- waits until that edge + the delay, on a
// core0 alarm. The Amiga's read DMA starts 1.0-5.4 ms after the edge (bulk 1.6-3.1, peak ~2.6 ms; spike D),
// wider than the driver's 124-byte scan window, so ~4-5% of reads miss the sync and are retried (HANDOFF 3bi). A later start (a step onto the cylinder, a commit long after the edge) goes at
// once. Armed with interrupts off, so the alarm cannot fire before its id is stored. True when the
// alarm starts it (or already has).
static bool pnet_go_later(bool side_return) {
    const uint32_t wait = pnet_go_wait_us(g_pnet_side_us, PNET_SIDE_DELAY_US, time_us_32());
    const pnet_go_kind_t kind = pnet_go_kind(wait, PNET_GO_MIN_US);
    if (kind == PNET_GO_ALARM) {
        const uint32_t irq = save_and_disable_interrupts();
        const alarm_id_t id = add_alarm_in_us(wait, pnet_go_due, NULL, true);
        if (id > 0) g_pnet_go_alarm = id;
        restore_interrupts(irq);
        if (id >= 0) {                   // 0: it was already due and ran at once
            return true;
        }
    }
    if (side_return) {
        if (kind == PNET_GO_SHORT) g_pnet_go_short++;   // due within PNET_GO_MIN_US: at once
        else g_pnet_go_late++;                          // the loop came after the due time (or no alarm slot was free)
    }
    return false;
}
#endif

#if WF_PNET_L2
// Phase 2 (spec 2026-10-11 §3.1): DF1's head on cylinder 76 side 1 -- Rob's PaulaNET.device reading the
// board's status when it opens and every 5 s after. Built fresh at every arrival, so the link state is
// current, and streamed from its own buffer (g_pnet_status_live). The loop repeats one record every
// 124 bytes, so a read that starts anywhere finds a sync inside the driver's scan: no start timing
// applies here (plan ruling 7). Nothing streams before core1 has published the MAC -- the driver keeps
// the MAC it reads at open -- so a too-early open fails, visibly, and is counted (ruling 10).
static void pnet_serve_status(void) {
    if (!g_pnet_mac_ok) { g_pnet_status_early++; return; }
    __dmb();                                     // the MAC's bytes were written before the flag
    pnet_status_t st;
    memset(&st, 0, sizeof st);
    memcpy(st.mac, g_pnet_mac, sizeof st.mac);
    st.rssi = g_pnet_rssi;
    st.link = net_radio_sta_joined() ? PNET_LINK_NOIP : PNET_LINK_DOWN;
    pnet_version_bytes(WF_FIRMWARE_VERSION, &st.ver_major, &st.ver_minor);
    st.lz4 = pnet_lz4_on() ? (uint8_t)(PNET_ST_LZ4_TO_AMIGA | PNET_ST_LZ4_FROM_AMIGA) : 0u;   // spec 2026-10-18 §3
    if (pnet_build_status((uint8_t *)g_pnet_status_words, sizeof g_pnet_status_words,
                          g_link.last_amiga, g_link.pico, &st) == 0) {
        wf_logf(WF_ERR, "pnet: the status record does not fit its %u-byte period -- not served",
                (unsigned)PNET_STATUS_PERIOD);
        return;
    }
    const uint32_t n = pnet_pack_words(g_pnet_status_words, PNET_STATUS_LOOP_BYTES);
    if (!pnet_stream_words(g_pnet_status_words, n)) return;
    g_pnet_echo_live = true;                     // the short INDEX at each wrap, as on cylinder 77
    g_pnet_last_ms = clock_ms() | 1u;            // cylinder 76 is network use too (the OTA rule)
    g_pnet_status_serves++;
    g_pnet_status_last_ms = clock_ms() | 1u;     // the driver read cylinder 76 (the report's "driver")
    pnet_index_now();
}
#endif

// serve_drive(1, ...) for this build: cylinder 77 is the loopback, every other track the disk.
static void pnet_serve_df1(int32_t tok, int *loaded) {
    const int want = want_track[1];
#if WF_PNET_L2
    const pnet_df1_t act = pnet_df1_for_track_l2(want);   // Phase 2: cylinder 76 as well
#else
    const pnet_df1_t act = pnet_df1_for_track(want);
#endif
    if (act == PNET_DF1_DISK) {
        // First: serve_drive can spend ~5 ms in an HD encode before its stream_stop, and a start
        // still pending must not fire on a disk cylinder and leave echo_live set.
        pnet_go_cancel();
#if PNET_SIDE_DELAY_US
        g_pnet_go_rearm = false;                 // a skipped start's rearm means nothing on a disk cylinder
#endif
        g_pnet_echo_live = false;
        g_pnet_prepared = false;                 // serve_drive refills track_words1
        serve_drive(1, tok, loaded);
        return;
    }
#if WF_PNET_L2
    // Side 1 streaming our batch counts as a read -- re-reads without a side change included -- only
    // while the Amiga really reads DF1: selected (SEL1 low) AND its motor on. The stream never stops
    // on its own, so a head parked here would otherwise hold the OTA forever; select alone is not
    // enough either (trackdisk polls a disk change selected, motor off). Review fix round 2.
    if ((act == PNET_DF1_ECHO || act == PNET_DF1_STATUS) && want == *loaded && g_pnet_echo_live && !gpio_get(PIN_SEL1) &&
        dskchg_motor_on_d(1))
        g_pnet_last_ms = clock_ms() | 1u;
#endif
    if (want == *loaded) return;
    const int was = *loaded;
    const bool commit = g_pnet_rst_commit;
    g_pnet_rst_commit = false;
    *loaded = want;
    pnet_go_cancel();                            // before echo_live drops: a pending start must not fire into this teardown
    g_pnet_echo_live = false;                    // set again only once the echo streams
    stream_stop(1);                              // the DMA reads track_words1 (and a start may be pending): stop first
    if (act == PNET_DF1_SILENT) return;          // side 0: the Amiga writes, nothing to read
#if WF_PNET_L2
    if (act == PNET_DF1_STATUS) { pnet_serve_status(); return; }
#endif
    const uint64_t t0 = time_us_64();
    // Normally the commit already built and packed this echo (pnet_prepare_echo): the restart
    // only starts the DMA, so how long after the SIDE edge the echo starts does not grow with N.
    if (!g_pnet_prepared && !pnet_prepare_echo()) return;
    const unsigned cause = commit ? PNET_RST_COMMIT
                         : was == PNET_TRACK_IN ? PNET_RST_SIDE : PNET_RST_OTHER;
    g_pnet_rst[cause]++;
    g_pnet_go_side = cause == PNET_RST_SIDE;
    bool later = false;
#if PNET_SIDE_DELAY_US
    later = pnet_go_later(cause == PNET_RST_SIDE);
#endif
    if (!later) pnet_go();
    const uint32_t us = (uint32_t)(time_us_64() - t0);
    if (us > g_pnet_build_max) g_pnet_build_max = us;
    g_pnet_build_sum += us;
    g_pnet_builds++;
}

// The loop's half of the pre-arm (pnet_loop.h): once per pass, arm the raw capture ahead of a DF1
// batch, or let a standing one go. Interrupts off from the reading to the action, so the WGATE ISR
// cannot claim or cancel in between -- a few register writes at most (arm()).
static void pnet_prearm_step(void) {
    const uint32_t irq = save_and_disable_interrupts();
    const pnet_prearm_in_t in = {
        .df1_serving = g_pnet_df1_mounted,
        .sel0 = !gpio_get(PIN_SEL0),                 // asserted = low, through the '541
        .wgate = !gpio_get(PIN_WGATE),
        .unpowered = g_bus_unpowered,
        .cyl1 = cur_cyl[1],
        .side = cur_side,
        .idle = flux_capture_idle(),
        .prearmed = flux_capture_prearmed(),
        .edges = flux_capture_prearm_edges(),
    };
    switch (pnet_prearm_gated(g_pnet_on, &in)) {     // Phase 3: outside Network, only ever a CANCEL
    case PNET_PREARM_ARM:    if (flux_capture_prearm_raw()) g_pnet_pre_arms++; break;
    case PNET_PREARM_CANCEL: if (flux_capture_prearm_cancel()) g_pnet_pre_cancel++; break;
    case PNET_PREARM_STRAY:  if (flux_capture_prearm_cancel()) g_pnet_pre_stray++; break;
    case PNET_PREARM_NONE:   break;
    }
    restore_interrupts(irq);
}

#if WF_PNET_L2
// Phase 1, every 5 s in which anything moved. Every counter is saturated at 9999999 (PNET_SAT), so each line
// fits the 87 characters wf_logf prints (WF_LOG_MSG is 88, with the NUL).
static void pnet_l2_log(void) {
    static uint32_t last_ms, last_sum;
    const uint32_t now = clock_ms();
    if (now - last_ms < 5000u) return;
    last_ms = now;
    pnet_bridge_stats_t st;
    pnet_bridge_stats(&st);
    uint32_t no = 0;
    for (unsigned i = 1; i < PNET_TX_N; i++) no += st.tx_no[i];
    const bool lz4b = pnet_lz4_backed();          // g_lz4 is read only when PSRAM backs it (ruling F9)
    const uint32_t sum = st.in_amiga + st.in_both + st.rx_drops + st.tx_sent + st.tx_err + no +
                         g_link.fresh + g_link.dup + g_link.queued + g_link.over + g_link.malformed +
                         g_link.acked + st.clash + st.hooks + g_pnet_status_serves + g_pnet_status_early +
                         st.a2b + st.b2a + st.local_drops + g_link.lz4_in + g_link.lz4_bad +
                         (lz4b ? g_lz4.out_lz4 + g_lz4.out_mfm : 0u);
    if (sum == last_sum) return;
    last_sum = sum;
#define PNET_SAT(v, m) ((unsigned long)((v) > (m) ? (m) : (v)))
#define S7(v) PNET_SAT((v), 9999999u)
    char a[16], b[16];
    pnet_ip_text(st.amiga_ip, a);
    pnet_ip_text(st.board_ip, b);
    wf_logf(WF_INFO, "pnet: l2 in a %lu b %lu drop %lu q %lu sent %lu err %lu",
            S7(st.in_amiga), S7(st.in_both), S7(st.rx_drops),
            S7(pnet_ring_count(&g_pnet_rx)), S7(st.tx_sent), S7(st.tx_err));
    // Phase 4: frames between the board and the Amiga, which never touch the radio.
    wf_logf(st.local_drops ? WF_WARN : WF_INFO, "pnet: l2 local a2b %lu b2a %lu drop %lu",
            S7(st.a2b), S7(st.b2a), S7(st.local_drops));
    wf_logf(no ? WF_WARN : WF_INFO, "pnet: l2 tx no len %lu mac %lu type %lu clash %lu ack %lu",
            S7(st.tx_no[PNET_TX_LEN]), S7(st.tx_no[PNET_TX_MAC]),
            S7(st.tx_no[PNET_TX_TYPE]), S7(st.tx_no[PNET_TX_CLASH]), S7(g_link.acked));
    // Phase 2: the Amiga's batches -- taken, resent; their frames queued, dropped on a full ring, and
    // dropped as malformed (spec §3.2: every drop counted).
    wf_logf(g_link.over || g_link.malformed ? WF_WARN : WF_INFO,
            "pnet: l2 from amiga new %lu dup %lu frames %lu over %lu bad %lu",
            S7(g_link.fresh), S7(g_link.dup), S7(g_link.queued), S7(g_link.over), S7(g_link.malformed));
    // LZ4 (spec 2026-10-18 §5): new batches to the Amiga -- frames by encoding, payload bytes on the wire, bytes LZ4
    // saved against MFM; frames from the Amiga in LZ4 and refused LZ4 (a bad size word included); what the driver
    // last asked for. On the out line (review M4: where the bench reads it): pnet_pack's time per new batch this
    // window (us), and the batches that spent PNET_PACK_LZ4_BUDGET_US with their frames sent MFM unencoded (review
    // I1). Then the take's time for the Amiga's new LZ4-asking batches this window (us): with the pack's, what PSRAM
    // costs on the bench.
    if (lz4b) {
        wf_logf(WF_INFO, "pnet: l2 lz4 out lz4 %lu mfm %lu wire %lu saved %lu us max %lu avg %lu budget %lu unenc %lu",
                S7(g_lz4.out_lz4), S7(g_lz4.out_mfm), S7(g_lz4.wire), S7(g_lz4.saved), S7(g_lz4.us_max),
                S7(g_lz4.us_n ? g_lz4.us_sum / g_lz4.us_n : 0u), S7(g_lz4.budget), S7(g_lz4.unencoded));
        wf_logf(g_link.lz4_bad ? WF_WARN : WF_INFO, "pnet: l2 lz4 in lz4 %lu bad %lu driver %s",
                S7(g_link.lz4_in), S7(g_link.lz4_bad), g_link.amiga_lz4 ? "lz4" : "stock");
        wf_logf(WF_INFO, "pnet: l2 lz4 dec us max %lu avg %lu n %lu",
                S7(g_lz4.dus_max), S7(g_lz4.dus_n ? g_lz4.dus_sum / g_lz4.dus_n : 0u), S7(g_lz4.dus_n));
        g_lz4.us_max = g_lz4.us_sum = g_lz4.us_n = 0;
        g_lz4.dus_max = g_lz4.dus_sum = g_lz4.dus_n = 0;
    }
    const bool same = st.amiga_ip != 0u && st.amiga_ip == st.board_ip;
    wf_logf(st.clash || same ? WF_WARN : WF_INFO, "pnet: l2 amiga %s board %s %s clash %lu heap %lu",
            a, b, same ? "SAME" : "distinct", PNET_SAT(st.clash, 999999u), PNET_SAT(g_pnet_heap_low, 999999u));
    // Phase 2: cylinder 76 -- loops streamed, reads before the MAC was known, and what it tells the driver.
    wf_logf(WF_INFO, "pnet: l2 status %lu early %lu link %s rssi %d",
            S7(g_pnet_status_serves), S7(g_pnet_status_early),
            net_radio_sta_joined() ? "up" : "DOWN", (int)g_pnet_rssi);
#undef S7
#undef PNET_SAT
}
#endif

// Every 5 s while there is traffic: counts, and the window's timings in microseconds.
static void pnet_log_summary(void) {
    static uint32_t last_ms, last_rx, last_lost, last_busy;
    // The pre-arm's counters at the last window's end (index order as in the line below).
    static uint32_t last_pre[6];
    const uint32_t now = clock_ms();
    if (now - last_ms < 5000u) return;
    last_ms = now;
    g_pnet_reject_logged = false;
    // This window's pre-arm counts, taken every window so none rolls into the next. Cancels by a
    // write and stray discards print the window even with no loopback traffic: they are the bus.
    const uint32_t pre_now[6] = {g_pnet_pre_arms, g_pnet_pre_used, g_pnet_pre_df0, g_pnet_pre_other,
                                 g_pnet_pre_stray, g_pnet_pre_cancel};
    uint32_t pre[6];
    for (unsigned i = 0; i < 6; i++) { pre[i] = pre_now[i] - last_pre[i]; last_pre[i] = pre_now[i]; }
    const uint32_t lost = g_pnet_lost, busy = g_pnet_busy;
    if (g_pnet.rx == last_rx && g_pnet_builds == 0 && lost == last_lost && busy == last_busy &&
        (pre[2] | pre[3] | pre[4]) == 0) return;
    last_rx = g_pnet.rx;
    last_busy = busy;
    const uint32_t *b = g_pnet.bad;
    uint32_t bad = 0;
    for (unsigned i = 0; i < PNET_E_COUNT; i++) bad += b[i];
    wf_logf(WF_INFO, "pnet: rx %lu new %lu dup %lu bad %lu ctr %02x/%02x echo %u fr busy %lu",
            (unsigned long)g_pnet.rx, (unsigned long)PNET_CTR.fresh, (unsigned long)PNET_CTR.dup,
            (unsigned long)bad, PNET_CTR.last_amiga, PNET_CTR.pico, (unsigned)PNET_CTR.nframes,
            (unsigned long)busy);
    wf_logf(WF_INFO, "pnet: us dec max %lu avg %lu ready max %lu build max %lu avg %lu bl %lu",
            (unsigned long)g_pnet_dec_max,
            (unsigned long)(g_pnet_decs ? g_pnet_dec_sum / g_pnet_decs : 0),
            (unsigned long)g_pnet_ready_max, (unsigned long)g_pnet_build_max,
            (unsigned long)(g_pnet_builds ? g_pnet_build_sum / g_pnet_builds : 0),
            (unsigned long)g_pnet_backlog_max);
    // This window's word 0 (arm -> first edge, ns) min/avg/max over the accepted (acc) and the
    // refused (rej) captures -- the arm latency -- and imp, the accepted ones whose sync was
    // implied (pnet_rx.h, bench fix 3). 0/0/0 when there were none.
    const pnet_lead_t *la = &g_pnet_lead[0], *lr = &g_pnet_lead[1];
    wf_logf(WF_INFO, "pnet: lead ns acc %lu/%lu/%lu rej %lu/%lu/%lu imp %lu",
            (unsigned long)(la->n ? la->min : 0), (unsigned long)(la->n ? la->sum / la->n : 0),
            (unsigned long)la->max, (unsigned long)(lr->n ? lr->min : 0),
            (unsigned long)(lr->n ? lr->sum / lr->n : 0), (unsigned long)lr->max,
            (unsigned long)g_pnet_implied);
    if (bad)
        wf_logf(WF_WARN, "pnet: bad nosync %lu magic %lu size %lu ck %lu frames %lu rle %lu full %lu oor %lu",
                (unsigned long)b[PNET_E_NOSYNC], (unsigned long)b[PNET_E_MAGIC],
                (unsigned long)(b[PNET_E_SHORT] + b[PNET_E_SIZE] + b[PNET_E_MODE]),
                (unsigned long)b[PNET_E_CHECKSUM],
                (unsigned long)(b[PNET_E_FRAMES] + b[PNET_E_FRAME_SIZE]),
                (unsigned long)b[PNET_E_RLE], (unsigned long)b[PNET_E_FULL],
                (unsigned long)b[PNET_E_RANGE]);
    // Restarts of the echo this window by cause, the no-op INDEX pulses among them, and the max
    // SIDE edge -> restart INDEX latency (us). Saturated so the line fits WF_LOG_MSG.
#define PNET_SAT(v, m) ((unsigned long)((v) > (m) ? (m) : (v)))
    wf_logf(WF_INFO, "pnet: restart side %lu commit %lu other %lu noop %lu side-idx max us %lu",
            PNET_SAT(g_pnet_rst[PNET_RST_SIDE], 99999u), PNET_SAT(g_pnet_rst[PNET_RST_COMMIT], 99999u),
            PNET_SAT(g_pnet_rst[PNET_RST_OTHER], 99999u), PNET_SAT(g_pnet_rst_noop, 99999u),
            PNET_SAT(g_pnet_side_idx_max, 9999999u));
#if PNET_SIDE_DELAY_US
    // Phase 2 Task 1: side-1 starts this window, from the alarm / at once because the loop came after
    // the due time, and the earliest SIDE edge -> start (the latest is side-idx max above).
    wf_logf(WF_INFO, "pnet: go at %u us: delayed %lu late %lu short %lu skipped %lu side-idx min us %lu",
            (unsigned)PNET_SIDE_DELAY_US, PNET_SAT(g_pnet_go_delayed, 999u), PNET_SAT(g_pnet_go_late, 9999u),
            PNET_SAT(g_pnet_go_short, 999u), PNET_SAT(g_pnet_go_skipped, 9999u),
            g_pnet_side_idx_min == UINT32_MAX ? 0ul : PNET_SAT(g_pnet_side_idx_min, 99999u));
#endif
    // The pre-arm this window: arms made, used by a DF1 batch, cancelled by a DF0 write / by any
    // other assert, discarded with stray edges, cancelled by the loop (head moved, DF1 off).
    // used < rx: the rest were armed by the WGATE ISR (the lead line above is theirs alone).
    wf_logf(WF_INFO, "pnet: prearm arm %lu used %lu df0 %lu other %lu stray %lu cancel %lu",
            PNET_SAT(pre[0], 99999u), PNET_SAT(pre[1], 99999u), PNET_SAT(pre[2], 99999u),
            PNET_SAT(pre[3], 99999u), PNET_SAT(pre[4], 99999u), PNET_SAT(pre[5], 99999u));
#undef PNET_SAT
    // The echo's build at the commit (pnet_prepare_echo), off the SIDE -> INDEX path.
    wf_logf(WF_INFO, "pnet: prep n %lu max us %lu avg %lu", (unsigned long)g_pnet_preps,
            (unsigned long)g_pnet_prep_max,
            (unsigned long)(g_pnet_preps ? g_pnet_prep_sum / g_pnet_preps : 0));
    if (lost != last_lost)
        wf_logf(WF_WARN, "pnet: lost %lu batches to DF0 writes (%lu in all)",
                (unsigned long)(lost - last_lost), (unsigned long)lost);
    last_lost = lost;
    g_pnet_dec_max = g_pnet_dec_sum = g_pnet_decs = g_pnet_ready_max = 0;
    g_pnet_build_max = g_pnet_build_sum = g_pnet_builds = g_pnet_backlog_max = 0;
    g_pnet_implied = 0;
    g_pnet_prep_max = g_pnet_prep_sum = g_pnet_preps = 0;
    for (unsigned i = 0; i < PNET_RST_N; i++) g_pnet_rst[i] = 0;
    g_pnet_rst_noop = g_pnet_side_idx_max = 0;
    g_pnet_side_idx_min = UINT32_MAX;
#if PNET_SIDE_DELAY_US
    g_pnet_go_delayed = g_pnet_go_late = g_pnet_go_short = g_pnet_go_skipped = 0;
#endif
    for (unsigned i = 0; i < 2; i++) g_pnet_lead[i] = (pnet_lead_t){UINT32_MAX, 0, 0, 0};
}

// Phase 3 (plan 2026-10-12, rulings 2-3): the runtime gate. core0, at boot and on every live DF1 change,
// before anything below reads g_pnet_on. Leaving the mode forgets the link: a pending start is cancelled, the
// prepared batch dropped, the frames waiting for the Amiga dropped (core0 is the RX ring's consumer; the
// bridge drops the TX side), the counters reset, and the driver counts as not heard from -- so a later
// Network mode starts as at boot. DF1's stream itself is stopped by the caller's unmount (df1_live_apply).
// A finished raw batch nobody took is discarded on every change, either way: one left from before would
// otherwise be taken as new by a later Network mode's fresh link.
static void pnet_set_mode(df1_mode_t m) {
    const bool was = g_pnet_on;
    const bool now = pnet_mode_on((uint8_t)m, PNET_ECHO_BUILD);
    // Leaving: DF1 stops counting as serving BEFORE the gate drops, so a WGATE landing in between can never
    // arm a raw capture (review m1; the WGATE ISR reads g_pnet_df1_mounted).
    if (was && !now) g_pnet_df1_mounted = false;
    g_pnet_on = now;
#if WF_PNET_L2
    pnet_bridge_set_on(g_pnet_on);
#endif
    if (was != g_pnet_on) {
        flux_capture_raw_t stale;
        if (flux_capture_take_raw(&stale)) pnet_raw_pending = false;
    }
    if (!was || g_pnet_on) return;
    // Review I1: a head left on cylinder 77 had WPROT released. Off does not set DF1's lines (df1_live.c) and
    // the STEP ISR no longer moves WPROT outside Network, so re-assert it here: protected on every cylinder.
    bus_out_set_drive(1, PIN_WPROT, pnet_df1_wprot_gated(g_pnet_on, cur_cyl[1]));
    pnet_go_cancel();
    g_pnet_echo_live = false;
    g_pnet_prepared = false;
#if WF_PNET_L2
    pnet_ring_drop(&g_pnet_rx, pnet_ring_count(&g_pnet_rx));
    pnet_link_init(&g_link);
    g_pnet_status_last_ms = 0;
    g_pnet_last_ms = 0;          // review m3: no network use any more, so a staged OTA is not held (pnet_ota_quiet)
    g_pnet_frames_from = g_pnet_frames_to = 0;
#else
    pnet_loop_init(&g_pnet);
#endif
    wf_logf(WF_INFO, "pnet: off -- DF1 is %s; the network link is forgotten", df1_mode_name(m));
}
#endif

// ---------------------------------------------------------------- DF0 present / absent
// core0 only (dskchg.c's state is single-threaded: see main()'s note above
// last_active_token). An eject, and the empty phase of a disk-over-disk swap
// (swap_phase.h), both go through df0_absent; a mount into an empty drive, and
// the end of that empty phase, both go through df0_present.

/** DF0 has no disk: /CHNG asserted with no image (a STEP cannot clear it),
 *  RDY off, nothing streams, the ID answers an empty DD drive. */
static void df0_absent(void) {
#if WF_DRIVE_ID
    if (bus_out_drive_id_set_hd(false))
        wf_logf(WF_INFO, "drive-id: now answering DD 0x%08lx (no disk)",
                (unsigned long)DRIVE_ID_DD);
#endif
    dskchg_image_ejected();
    stream_stop(0);
}

/** DF0 has the disk in `slot`: the ID first, then the insert. */
static void df0_present(int slot, int32_t token) {
    (void)slot;
#if WF_DRIVE_ID
    // Before the insert is announced, so an ID read the change
    // prompts sees the new disk's density. Taken at the next
    // answer -- the first motor-off select after a motor-on one,
    // or the 32-bit repeat -- never mid-answer (bus_out.c, which
    // writes drive_id's Y). Whether Kickstart re-reads the ID
    // on a change at all is bench step 9. HD writes spec §4.5:
    // WPROT no longer derives HD from the slot kind
    // (write_back_wprot) -- this is now the only place that does.
    const bool hd = psram_image_slot_kind(slot) == SLOT_KIND_ADF_HD;
    if (bus_out_drive_id_set_hd(hd))
        wf_logf(WF_INFO, "drive-id: now answering %s 0x%08lx",
                hd ? "HD" : "DD", (unsigned long)drive_id_for(hd));
#endif
    dskchg_image_inserted();
    wf_trace(WF_EV_MOUNT, (uint32_t)token, 0);
}

// ---------------------------------------------------------------- main
// Defined by the SDK (hardware_psram/psram.c) but not declared in any public
// header; normally run before main() by runtime init, which this build skips
// (PICO_RUNTIME_SKIP_INIT_PSRAM=1 -- see CMakeLists.txt and main() below).
extern void runtime_init_setup_psram(void);

int main(void) {
    // FIRST, before stdio, core1, or any PSRAM user: a trial that proved
    // itself last boot is bought here, single-core (fw_rom.c, fix round 4).
    fw_rom_boot_early(WF_FIRMWARE_VERSION);
    // THEN PSRAM, on every boot, before anything that touches it (the log
    // ring is SRAM; track_cache_init/psram_image_init and everything after
    // use PSRAM). The SDK's pre-main PSRAM init is skipped
    // (PICO_RUNTIME_SKIP_INIT_PSRAM=1) because the ROM buy above hangs,
    // measured, whenever PSRAM is configured. IRQs off around it: it runs
    // flash_start_xip() (XIP briefly down), which pre-main init ran with no
    // IRQ sources live; here the default alarm pool's timer IRQ already is.
    {
        uint32_t irq = save_and_disable_interrupts();
        runtime_init_setup_psram();
        restore_interrupts(irq);
    }
    stdio_init_all();
    wf_log_init();
    wf_logf(WF_INFO, "wifi-floppy boot: %s", PICO_BOARD);

    {
        char why[96];
        if (!board_check(g_board, why, sizeof why)) {
            // A code error, not a field condition: the table in board.c is
            // wrong. Stop before driving a single pad. A TBYB trial image is
            // reverted by the watchdog the boot ROM armed for it (not by
            // FW_TRIAL_DEADLINE_MS: fw_rom_service() runs on core0's loop,
            // which this never reaches); any other boot just stays halted.
            // Core0's loop is what drains the log ring, so drain it here or
            // the line below never reaches the console.
            wf_logf(WF_ERR, "board: %s fails its check: %s", g_board->name, why);
            while (1) {
                wf_log_drain(4);
                tight_loop_contents();
            }
        }
        wf_logf(WF_INFO, "board: %s", g_board->name);
    }

    // inputs. PIN_WDATA belongs here too even though only PIO reads it: an
    // RP2350 pad stays isolated from reset until gpio_set_function() clears
    // ISO, and until then PIO reads it as 0 whatever the pin carries. Left
    // out, WDATA read low in every sample, with 1k to +5V on J1 pin 22 and
    // the Amiga idle (2026-09-15).
    const uint ins[] = {PIN_SEL0, PIN_SEL1, PIN_MTR, PIN_DIR,
                        PIN_STEP, PIN_WDATA, PIN_WGATE, PIN_SIDE};
    for (unsigned i = 0; i < count_of(ins); i++) {
        gpio_init(ins[i]); gpio_set_dir(ins[i], GPIO_IN);
    }

    // Status outputs (FET gates): handed to the status_gate PIO, which drives
    // them only while SEL0 is asserted -- so AFTER the inputs, or the gate's
    // first loops read SEL0's still-isolated pad as 0, "selected". From here
    // on bus_out_set() is the only way to change one -- gpio_put() on these
    // pads does nothing.
    //
    // TRK0: powered on at cyl 0. WPROT: a boot-time default, before core1 has
    // even started, let alone learned whether a disk is mounted or what the
    // server says about it -- core1's main loop is the only thing that writes
    // WPROT after this (see its WPROT comment), but "asserted" is the only
    // safe value to boot with regardless: read-only until proven otherwise
    // beats writable by default.
    // DF1 (spec 2026-10-08): the stored setting, before the first ID read --
    // Kickstart reads every drive's ID at power-on, seconds before Wi-Fi.
    {
        static drive_record_t drv_rec;           // static: off core0's stack
        const bool drv_loaded = drive_store_load(&drv_rec);
        g_df1_mode = drive_boot_mode(drv_loaded, &drv_rec);
        g_drive_boot_ack = drv_loaded ? drv_rec.version : 0;   // core1 seeds driveAck (Phase 3)
#if !DF1_CAPABLE
        if (g_df1_mode != DF1_MODE_OFF)
            wf_logf(WF_WARN, "df1: stored ON, but this build has no drive-ID responder -- off");
        g_df1_mode = DF1_MODE_OFF;
#endif
        wf_logf(WF_INFO, "df1: %s at boot (%s)",
                df1_mode_name(g_df1_mode),
                drv_loaded ? "stored" : "compiled default");
    }
#if WF_PNET_LOOP
    pnet_loop_init(&g_pnet);
#if WF_PNET_L2
    pnet_link_init(&g_link);
#endif
#if PNET_ECHO_BUILD
    wf_logf(WF_WARN, "%s: DF1 cylinder 77 is a PaulaNET loopback (bench only)", wf_pnet_loop_marker);
#endif
    wf_logf(WF_INFO, "pnet: side-1 lead-in %u B, side-return start %u us after SIDE",
            (unsigned)PNET_TX_LEAD_BYTES, (unsigned)PNET_SIDE_DELAY_US);
#if WF_PNET_L2
    pnet_bridge_init();           // the PSRAM rings, before core1 (their other side) starts
    // LZ4 (spec 2026-10-18 §5): its state and buffers, PSRAM like the rings; off both ways unless all are backed.
    // The result is kept here for the log: g_lz4 itself is touched only when its own check passed (ruling F9).
    {
        const bool st_ok = pnet_lz4_backed();
        bool ok = false;
        if (st_ok) {
            memset(&g_lz4, 0, sizeof g_lz4);
            ok = psram_check_address(&g_lz4_tx_win[PNET_LZ4_WINDOW - 1u]) &&
                 psram_check_address(&g_lz4_tx_blk[PNET_LZ4_WINDOW - 1u]) &&
                 psram_check_address(&g_lz4_table[PNET_LZ4_TABLE_ENTRIES - 1u]) &&
                 psram_check_address(&g_lz4_rx_win[PNET_LZ4_WINDOW - 1u]) &&
                 psram_check_address(&g_lz4_rx_scratch[PNET_LZ4_BLOCK_MAX - 1u]);
            g_lz4.ok = ok;
            // The hash table is zeroed here, once (bench fix, seq 100: pnet_pack no longer clears it per batch).
            // Any contents would be correct -- the encoder byte-verifies every candidate -- but 0 is position 0x8000
            // once un-XORed (pnet_lz4.c), past any 16,128-byte window, so a zero entry is never even a candidate.
            if (ok) memset(g_lz4_table, 0, sizeof g_lz4_table);
        }
        wf_logf(ok ? WF_INFO : WF_ERR, "pnet: lz4 %s",
                ok ? "on (table 4096, 57 KB of PSRAM)"
                   : st_ok ? "OFF -- its buffers are not backed by PSRAM"
                           : "OFF -- its state is not backed by PSRAM (L2 will fail too)");
    }
#endif
    if (!psram_check_address(&g_pnet_echo[1][PNET_ECHO_BYTES - 1]))
        wf_logf(WF_ERR, "pnet: the echo store is not backed by PSRAM -- the loopback will fail");
    pnet_set_mode(g_df1_mode);    // Phase 3: the gate, before the bus IRQs are enabled
    wf_logf(WF_INFO, "pnet: network path built in; %s", g_pnet_on ? "on (DF1 is Network)" : "off");
#endif
    // One word per drive; PIN_* are board reads, so filled here, not static.
    uint32_t boot_lines[WF_DRIVES];
    boot_lines[0] = (1u << PIN_TRK0) | (1u << PIN_WPROT);   // DF0, as before
    // DF1: an empty, write-protected drive at track 0 until a disk is
    // inserted. WPROT stays asserted for good: DF1 is read-only, and core1's
    // WPROT writer is DF0's alone (bus_out_set). The word is the same whatever
    // the setting: an OFF DF1's machines are not started (bus_out_drive_enable
    // below; a live switch ON starts them later, df1_live.h), and a disabled
    // machine writes no pad -- off is no DF1 at all, even while SEL0 and SEL1
    // are low together.
    boot_lines[1] = (1u << PIN_TRK0) | (1u << PIN_WPROT) | (1u << PIN_CHNG);
    n_drives = DF1_CAPABLE ? 2u : 1u;
    bus_out_init(bus_pio, n_drives, boot_lines);   // starts DF0's gate only

    dskchg_init();
    dskchg_set_drives(n_drives);
    track_cache_init();

    // Both are hand-wired bring-up aids on unrouted header pins and both are
    // no-ops with nothing attached, so neither is conditional: a board with no
    // LED and no panel simply logs that it found no panel.
    led_init();
    // Three blinks, scheduled not blocked. With no Amiga connected there is no
    // floppy traffic at all, so this is the only thing that distinguishes a
    // working LED from a backwards one before the cable goes on.
    led_selftest(3);
    {
        // OLED layouts (spec 2026-10-04 §6): the stored panel type and layout,
        // loaded before the first frame. Nothing stored, a bad CRC, or a
        // record whose fields are out of range all mean the 128x32 default
        // and a display cursor of 0 -- the board then takes whatever the
        // server holds. A stored blob that no longer validates keeps the
        // stored panel and version but draws that panel's default.
        panel_t boot_panel = PANEL_128x32;
        const layout_t *boot_layout = NULL;          // NULL = the panel's default
        uint8_t boot_rot = LAYOUT_ROT_0;             // from the stored layout's blob (1.17.0)
        {
            static display_record_t rec;             // static: ~140 bytes, read once
            if (display_store_load(&rec)) {
                const bool sane = rec.panel <= PANEL_128x64 && rec.has_layout <= 1 &&
                                  rec.blob_len <= LAYOUT_BLOB_MAX &&
                                  (rec.has_layout ? rec.blob_len > 0 : rec.blob_len == 0);
                if (!sane) {
                    wf_logf(WF_WARN, "display: stored record out of range -- 128x32 default");
                } else {
                    boot_panel = (panel_t)rec.panel;
                    g_display_boot_ack = rec.version;
                    g_display_panel = rec.panel;   // before core1 launches
                    if (rec.has_layout) {
                        char why[48] = "";
                        if (layout_decode(rec.blob, rec.blob_len, &g_layout_applied, why, sizeof why) &&
                            g_layout_applied.panel == boot_panel) {
                            boot_layout = &g_layout_applied;
                            boot_rot = layout_rotation(rec.blob, rec.blob_len);
                        } else {
                            wf_logf(WF_WARN, "display: stored layout refused (%s) -- the panel's default",
                                    why[0] ? why : "panel mismatch");
                        }
                    }
                    wf_logf(WF_INFO, "display: stored version %lu, %s, %s layout%s",
                            (unsigned long)rec.version,
                            boot_panel == PANEL_128x64 ? "128x64" : "128x32",
                            boot_layout ? "custom" : "default",
                            boot_rot == LAYOUT_ROT_180 ? ", turned 180" : "");
                }
            }
        }
        // Always initialised, panel or not: core0's loop renders into g_disp on
        // every state change, and display_render needs a layout. 1.7.1 only set
        // one up when a panel answered, so a board with no (or a dead) panel
        // drew through a NULL layout and faulted ~1 s after boot. The pump is
        // what touches the bus, and it stays gated on g_panel_addr.
        display_init(&g_disp, panel_blit, NULL);
        uint8_t panel = 0;
        i2c_probe_bus(&panel, &g_i2c_scan);
        // Only when a panel actually answered: a missing display must cost
        // nothing, and must certainly not put bounded-but-real bus writes in
        // front of a board that is trying to boot.
        if (panel != 0 && ssd1306_selftest(panel, boot_panel)) {
            // The self-test leaves the frame-and-X on the glass. Clear it, or
            // the pump's first update would show the test pattern through
            // every byte the new frame happens to leave blank -- display.c's
            // shadow starts all-zero and only sends what DIFFERS, which is
            // the whole reason a track step costs a few bytes and not a frame.
            ssd1306_clear(panel, boot_panel);
            g_panel_addr = panel;
            // display_init assumes 128x32; a stored 128x64 switches it (the
            // panel is already initialised for it by the self-test above).
            if (boot_panel != g_disp.panel) display_set_panel(&g_disp, boot_panel);
            if (boot_layout) display_set_layout(&g_disp, boot_layout);
            // A stored rotation (1.17.0): the glass is all zero after the
            // clear, so turning it now needs no resend.
            if (boot_rot != LAYOUT_ROT_0 && !ssd1306_set_rotation(panel, boot_rot))
                wf_logf(WF_WARN, "display: stored rotation failed");
            ui_publish(DS_BOOT, "wifi-floppy", "starting", -1);
        }
        // The tag reader, on the bus i2c_probe_bus just initialised: 400 kHz
        // if a panel answered, else still the probe's 100 kHz, left as is.
        // Nothing touches the chip here -- the first nfc_step() is the
        // boot-time presence check, in the service loop's display slot.
        // Two chips are looked for, the Si512 at 0x28 first, then a PN532 at
        // 0x24 (nfc_reader.h); the same i2c1, the same rules.
        nfc_bus_t nfc_bus;
        nfc_bus_i2c(&nfc_bus);
        nfc_init(&g_nfc, &nfc_bus, clock_ms);
        nfc_frame_bus_t nfc_fbus;
        nfc_frame_bus_i2c(&nfc_fbus);
        nfc_attach_pn532(&g_nfc, &nfc_fbus);
    }
    // psram_image_init() runs inside track_cache_init() and its bool result is
    // discarded there. Say it out loud, because PSRAM is the one part of this
    // board no footprint check and no host test can vouch for: a pin-compatible
    // module WITHOUT the PSRAM this design needs fits U1 perfectly, and the only
    // symptom is that image_parse_begin() goes straight to its error state and
    // every single fetch fails -- silently, forever, on a board that otherwise
    // associates, registers and polls perfectly.
    {
        bool ok = psram_image_available();
        wf_logf(ok ? WF_INFO : WF_ERR, "psram: %s (%u KB needed for %d slots)",
                ok ? "available" : "NOT AVAILABLE -- every image fetch will fail",
                (unsigned)((size_t)SLOT_COUNT * NUM_TRACKS * TRACK_MAX_BYTES / 1024u),
                SLOT_COUNT);
    }
    // The firmware-update stage (2b) sits after the image slots in PSRAM.
    // Checked here -- after runtime_init_setup_psram() above -- and before
    // core1 launches, which is the only reader of g_fw_stage_ok.
    g_fw_stage_ok = psram_check_address(&g_fw_stage[FW_MAX_IMAGE_BYTES - 1]);
    if (!g_fw_stage_ok)
        wf_logf(WF_ERR, "fw: the update stage is not backed by PSRAM -- updates disabled");

    // PIO
    uint off_out = pio_add_program(pio, &flux_out_program);
    g_stream[0].sm = pio_claim_unused_sm(pio, true);
    flux_out_program_init(pio, g_stream[0].sm, off_out, PIN_RDATA, PIN_SEL0);
    pio_sm_set_enabled(pio, g_stream[0].sm, true);
#if DF1_CAPABLE
    // DF1's flux, the same program copy, gated by SEL1. Both machines share
    // RDATA: flux_out side-sets only on its own pulse, so an idle or
    // deselected one writes nothing (floppy.pio). It runs whatever the DF1
    // setting: while DF1 is off it is never fed (only a DF1 mount, which needs
    // DF1 on, starts its stream) and stalls at `out` with no side-set -- it
    // never writes RDATA. (DF1's sel_mtr, below, only reads pins.)
    g_stream[1].sm = pio_claim_unused_sm(pio, true);
    flux_out_program_init(pio, g_stream[1].sm, off_out, PIN_RDATA, PIN_SEL1);
    pio_sm_set_enabled(pio, g_stream[1].sm, true);
#endif

    // flux_in lives on pio2 (step_pio), claimed before step_dir: the order
    // there is flux_in, step_dir, then the radio (core1, launched below).
    uint off_in = pio_add_program(step_pio, &flux_in_program);
    sm_in = pio_claim_unused_sm(step_pio, true);
    flux_in_program_init(step_pio, sm_in, off_in, PIN_WDATA);
    // Claims a DMA channel, points it at sm_in's RX FIFO, and ENABLES sm_in for good:
    // nothing writes pio2's CTRL enable bits after this (core1, which shares the
    // block through the radio, starts below). A capture is gated by the channel --
    // see flux_capture_arm().
    flux_capture_init(step_pio, sm_in);

    g_stream[0].dma = dma_claim_unused_channel(true);
#if DF1_CAPABLE
    g_stream[1].dma = dma_claim_unused_channel(true);
#endif
    irq_set_exclusive_handler(DMA_IRQ_0, dma_irq);
    irq_set_enabled(DMA_IRQ_0, true);

    // STEP and DIR are not GPIO interrupts: see step_dir in floppy.pio. This
    // shares pio2 with flux_in and the CYW43 driver, which claims a state
    // machine there when core1 brings the radio up (see bus_pio above); the
    // "pio claims" line in the log says where it landed.
    uint off_step = pio_add_program(step_pio, &step_dir_program);
    step_sm = pio_claim_unused_sm(step_pio, true);
    step_dir_program_init(step_pio, step_sm, off_step, PIN_STEP, PIN_SEL0);
    pio_set_irq0_source_enabled(step_pio, pio_get_rx_fifo_not_empty_interrupt_source(step_sm),
                                true);
    irq_set_exclusive_handler(pio_get_irq_num(step_pio, 0), step_pio_isr);
    irq_set_enabled(pio_get_irq_num(step_pio, 0), true);
    pio_sm_set_enabled(step_pio, step_sm, true);

    // MTR is latched on SEL0's falling edge (sel_mtr), not followed edge by
    // edge: MTR is shared, and only the selected drive takes it.
    // One machine per configured drive, the same program copy: DF1's latches
    // MTR on SEL1's fall.
    uint off_mtr = pio_add_program(bus_pio, &sel_mtr_program);
    for (unsigned d = 0; d < n_drives; d++) {
        const uint sm = pio_claim_unused_sm(bus_pio, true);
        sel_mtr_program_init(bus_pio, sm, off_mtr, d == 0 ? PIN_SEL0 : PIN_SEL1, PIN_MTR);
        pio_set_irq0_source_enabled(bus_pio, pio_get_rx_fifo_not_empty_interrupt_source(sm), true);
        mtr_sm[d] = (int)sm;
    }
    irq_set_exclusive_handler(pio_get_irq_num(bus_pio, 0), mtr_pio_isr);
    irq_set_enabled(pio_get_irq_num(bus_pio, 0), true);
    for (unsigned d = 0; d < n_drives; d++) pio_sm_set_enabled(bus_pio, (uint)mtr_sm[d], true);

#if WF_DRIVE_ID
    // The Amiga drive-ID answer on RDY (HD spec §5.4). pio0, beside flux_out:
    // 7 + 15 = 22 of its 32 instruction slots, one copy of each program,
    // shared by DF0's and DF1's machines.
    bus_out_drive_id_init(pio, n_drives);         // starts DF0's only
    // DF1: the kind first (written into its machine's Y while it is still
    // disabled), then -- only while DF1 is on -- its status gate and drive_id
    // machines start together, so its first answer is already DD. Off, they
    // stay disabled: no ID answer, no line, nothing written on any pad -- an
    // absent drive (Kickstart reads its ID as 0 from the bus pull-ups).
    bus_out_drive_id_set(1, g_df1_mode != DF1_MODE_OFF ? DRIVE_ID_KIND_DD : DRIVE_ID_KIND_NONE);
    bus_out_drive_enable(1, g_df1_mode != DF1_MODE_OFF);
    wf_logf(WF_INFO, "drive-id: answering DD 0x%08lx on DF0, %s on DF1",
            (unsigned long)DRIVE_ID_DD, g_df1_mode != DF1_MODE_OFF ? "DD" : "nothing (DF1 off)");
#endif
    // DF1's acknowledge cursor: the boot word (0, nothing published) is seen.
    psram_df1_reader_ack(psram_df1_token());

#if WF_BUS_SNIFF
    // pio2, IRQ1 (step_dir keeps IRQ0, the radio uses none). Claimed before
    // the radio, which needs the last free SM and 6 slots there: 4 SMs and
    // 30 of 32 instructions in this build.
    uint off_sniff = pio_add_program(step_pio, &bus_sniff_program);
    sniff_sm = pio_claim_unused_sm(step_pio, true);
    bus_sniff_program_init(step_pio, sniff_sm, off_sniff);
    pio_set_irq1_source_enabled(step_pio, pio_get_rx_fifo_not_empty_interrupt_source(sniff_sm),
                                true);
    irq_set_exclusive_handler(pio_get_irq_num(step_pio, 1), sniff_isr);
    irq_set_enabled(pio_get_irq_num(step_pio, 1), true);
    pio_sm_set_enabled(step_pio, sniff_sm, true);
    wf_logf(WF_WARN, "BUS SNIFF BUILD: every bus change is logged "
                     "(a = GPIO mask, GP0..13 without WDATA/RDATA; bit 16 = samples dropped before)");
#endif

    gpio_set_irq_enabled_with_callback(PIN_SEL0, GPIO_IRQ_EDGE_FALL, true, gpio_isr);
    gpio_set_irq_enabled(PIN_SIDE, GPIO_IRQ_EDGE_FALL | GPIO_IRQ_EDGE_RISE, true);
    gpio_set_irq_enabled(PIN_SEL1, GPIO_IRQ_EDGE_FALL, true);
    // Both edges: the falling one starts a capture and the rising one ends it,
    // and an end that is missed would run the ring into the next write.
    gpio_set_irq_enabled(PIN_WGATE, GPIO_IRQ_EDGE_FALL | GPIO_IRQ_EDGE_RISE, true);

    // NOT multicore_launch_core1(): that uses the SCRATCH_X-resident
    // .stack1_dummy, which tops out at 4 KB and cannot hold core1's
    // measured ~4.9 KB worst case (foreground TLS setup plus the lwIP/
    // mbedTLS IRQ chain that runs on the same stack). See core1_stack's
    // comment above.
    fw_rom_boot_init();
    {
        // Final review I3: tell fw_rom whether a trial has anything to revert
        // to, BEFORE core1 starts -- the portal and pairing come first on a
        // new board, and a USB-install trial (no pending record) must not
        // hit the 5-minute deadline there. A plain XIP read; core1 loads
        // the record again for itself in the poll loop's branch.
        static fw_state_t early_fst;   // static: off core0's stack
        fw_state_load(&early_fst);     // zeroed if no record
        fw_rom_set_trial_revertible(early_fst.pending);
        if (fw_rom_trial_boot())
            wf_logf(WF_INFO, "boot: trial is %s", early_fst.pending
                    ? "an OTA update (5-minute deadline armed)"
                    : "a USB install (no deadline: waiting for connectivity)");
    }
    {
        // The server override (1.13.0, spec §2): which server this boot talks
        // to, settled BEFORE core1 starts -- core1's clients read g_server and
        // never see it change (a console change reboots instead). A plain
        // XIP read, like fw_state_load above.
        server_override_t stored;
        const bool have_override = override_store_load(&stored);
        server_effective(have_override, &stored, WEBADF_HOST, &g_server);
        server_host_header(&g_server, g_server_hdr, sizeof g_server_hdr);
        tls_set_noverify(g_server.tls == OVR_TLS_NOVERIFY);
        if (server_is_custom(&g_server, WEBADF_HOST))
            // Operative words first, host LAST (spec D5, never silent): a long
            // host is what the 87-character log cut drops, never "INSECURE".
            wf_logf(g_server.tls == OVR_TLS_NOVERIFY ? WF_WARN : WF_INFO, "server: custom, tls=%s: %s",
                    g_server.tls == OVR_TLS_NOVERIFY ? "noverify -- INSECURE" : "verify", g_server_hdr);
        else wf_logf(WF_INFO, "server: default %s", WEBADF_HOST);
    }
    multicore_launch_core1_with_stack(core1_main, core1_stack, sizeof core1_stack);
    // Lets core1's (rare, one-time) token flash write -- token_store.c,
    // guarded to only ever run before any disk is mounted -- pause core0
    // for its duration via flash_safe_execute's multicore lockout: core0
    // executes nothing at all (interrupts disabled) while XIP is down.
    // This -- not the DMA IRQ's __not_in_flash_func above -- is what
    // actually prevents that handler from stalling mid-flash-write; see
    // its comment for why RAM-placement alone does not fully cover it
    // (its own call graph still reaches into flash). __not_in_flash_func
    // is kept as a second, cheap layer regardless.
    // multicore_launch_core1() returns almost immediately, so the question
    // is whether core1 can reach a flash write before this line runs.
    //
    // Final-review Minor 6: this comment used to answer that with "core1
    // has a WiFi connect, an SNTP sync, and a register round-trip ahead of
    // it", which plan 4b made false -- the FIRST flash write on a
    // freshly-provisioned board is now config_store_save(), which lands in
    // core1_main()'s portal branch ahead of all three. The conclusion is
    // unchanged and if anything stronger: that write happens only after
    // the AP has been raised, a phone has joined it, a human has filled in
    // a form, and the board has associated with what they typed -- seconds
    // at the very best, and realistically much longer. There is no
    // meaningful race with doing this init here rather than earlier; the
    // reason stated for it just had to stop naming the wrong first write.
    flash_safe_execute_core_init();

    want_track[0] = 0;
    want_track[1] = 0;   // DF1's head boots at cylinder 0 too (read only while DF1 holds a disk)

    // Track service: psram_image.h/.c's own repeated documentation is
    // explicit that "core0 (track_cache.c's track_cache_get()) is the only
    // reader" of the published active slot -- this loop is where that
    // reading happens, in the same real-time loop as dskchg_poll(), NOT in
    // core1_main()'s loop. core1's loop now blocks for tens of seconds at
    // a time inside dc_step()'s long poll; a track change noticed only
    // when that call returns would leave the flux DMA replaying a stale
    // track for however long is left of the poll, which the Amiga would
    // see as reading the wrong data after a seek. track_cache.h's
    // track_cache_get() comment previously said "Core 1" -- corrected
    // alongside this move.
    //
    // Review round 1, Critical C-1: a seek (a STEP pulse, which is what
    // sets `want_track`) was previously the ONLY thing that ever re-entered
    // track_cache_get(), so a swap or an eject with no seek in between was
    // invisible here -- the flux DMA would keep replaying whatever track it
    // last loaded from a disk that may no longer even be mounted, with
    // INDEX still pulsing, forever. last_active_token latches
    // psram_active_token() (see track_cache_check_swap(), which is the
    // pure/host-tested half of this fix) so this loop notices the change
    // itself, independent of `want_track`, and reacts immediately: force
    // re-entry into track_cache_get() at the CURRENT head position (a swap
    // takes effect right away, not on the next seek), and on an eject stop
    // the flux DMA outright rather than letting it run one more revolution
    // on a disk that is already gone.
    //
    // Review round 1, Important I-1: dskchg_image_inserted()/ejected() are
    // called from here too, not from core1 -- see core1_main()'s comment
    // on `mounted`. This keeps dskchg.c's `st` single-threaded (only ever
    // touched from core0: gpio_isr, dskchg_poll, and this call), since it
    // is plain and unsynchronized.
    int32_t last_active_token = 0;   // psram_image.c: 0 == the fresh-boot sentinel
    int loaded = -1;
#if DF1_CAPABLE
    // DF1: the word last acknowledged (0, the boot word, acked above), the
    // track its stream holds, and whether that word is a disk DF1 serves.
    int32_t df1_seen_tok = psram_df1_token();
    int     loaded1 = -1;
    bool    df1_mounted = false;
    // Set by a live switch ON: look at DF1's published word again even though
    // it did not change -- a disk core1 handed over is then inserted.
    bool    df1_rescan = false;
    // The DF1 setting's deferred flash record (D3, R17): written with both
    // drives empty or the Amiga idle (the store block below); a failed save
    // retries in 5 s.
    static drive_record_t drive_store_rec;
    bool     drive_store_pending = false;
    uint32_t drive_save_retry_at = 0;
    uint32_t drive_motor_seen_ms = 0;   // the last pass either motor was on (R17)
#endif
    // Display bookkeeping. `disk_mounted` gates BOTH the track counter (a
    // cylinder number with no disk in the drive is a number about nothing)
    // and the pump's budget, because the real-time duty only exists while
    // the Amiga has something to read.
    bool disk_mounted = false;
    // A disk-over-disk swap shows the drive empty first (swap_phase.h). While
    // it does, disk_mounted / df1_mounted still say a disk is assigned (the
    // glass keeps its title and the track counter), but nothing streams and
    // dskchg says no image.
    swap_phase_t df0_phase;
    swap_phase_init(&df0_phase);
#if DF1_CAPABLE
    swap_phase_t df1_phase;
    swap_phase_init(&df1_phase);
#endif
#if WF_VERIFY_TRACKS
    int verify_next = NUM_TRACKS;      // nothing to sweep until a disk mounts
    unsigned verify_bad = 0;
#endif
    display_state_t ui, last_ui;
    memset(&last_ui, 0, sizeof last_ui);
    char     ui_tag[NFC_UI_LINE_BYTES];
    uint32_t ui_tag_at, ui_tag_n;
    nfc_tag_clock_t ui_tag_clock;        // ends each tag line once (nfc_ui.h)
    nfc_tag_clock_init(&ui_tag_clock);
    nfc_armed_t nfc_armed;               // core0's view of the armed tag write
    nfc_armed_init(&nfc_armed);
    bool pump_failed = false;            // the last pump had work and sent nothing
    // OLED layouts: core0's cursor into core1's display handoff, a forced
    // re-render after a new layout (the state may not have changed at all),
    // and the deferred store write's retry time after a failed save.
    uint32_t display_seen = g_display_seq;
    bool     display_rerender = false;
    uint32_t display_save_retry_at = 0;
    bool     display_save_failed = false;
    // Bus power (bus_power.h), sampled every BUS_POWER_SAMPLE_MS below. The
    // input pads as a gpio_get_all() mask, built once: g_board is fixed.
    bus_power_t bus_power;
    bus_power_init(&bus_power);
    uint32_t bus_power_at = clock_ms();
    const uint32_t bus_inputs = (1u << PIN_SEL0) | (1u << PIN_SEL1) | (1u << PIN_MTR) |
                                (1u << PIN_WGATE) | (1u << PIN_STEP) | (1u << PIN_DIR) |
                                (1u << PIN_SIDE);
    bool motor_off_unpowered = false;   // the next "motor: DF0 off" line's reason
    fw_rom_watchdog_start();
    while (true) {
        fw_rom_service();
        dskchg_poll();
        // The Amiga switched off (bus_power.h): its pull-ups lose +5 V and
        // every input reads asserted. sel_mtr latches MTR only on a SEL0 fall,
        // so the power-down could leave "motor on" latched for good -- and the
        // OTA idle gate, the DF1 store and the swap hold all trust that flag.
        // All seven low for BUS_UNPOWERED_MS clears it; once power returns,
        // the first SEL0 fall latches the real value again.
        if (clock_ms() - bus_power_at >= BUS_POWER_SAMPLE_MS) {
            bus_power_at = clock_ms();
            switch (bus_power_step(&bus_power, gpio_get_all() & bus_inputs, bus_power_at)) {
            case BUS_POWER_LOST: {
                g_bus_unpowered = true;
                const unsigned was_on = mtr_force_off();
                motor_off_unpowered = (was_on & 1u) != 0;
                wf_logf(WF_INFO, "bus: unpowered (all pads low for %u ms; Amiga off?) -- "
                                 "motor latch cleared, DF0 was %s, DF1 was %s",
                        (unsigned)BUS_UNPOWERED_MS, (was_on & 1u) ? "ON" : "off",
                        (was_on & 2u) ? "ON" : "off");
                break;
            }
            case BUS_POWER_RETURNED: {
                g_bus_unpowered = false;
                static char pads[96];
                bus_pads_str(pads, sizeof pads);
                wf_logf(WF_INFO, "bus: powered | %s", pads);
                break;
            }
            default:
                // Still unpowered: a select glitch since the last sample can
                // have latched "on" again (the re-arm reports any next latch),
                // and nothing else would clear it. Clear it on every sample.
                if (g_bus_unpowered) {
                    bool any_on = false;
                    for (unsigned d = 0; d < WF_DRIVES; d++)
                        if (mtr_sm[d] >= 0 && dskchg_motor_on_d(d)) any_on = true;
                    if (any_on) {
                        const unsigned was_on = mtr_force_off();
                        wf_logf(WF_INFO, "bus: still unpowered -- a glitch latched the motor "
                                         "(DF0 %s, DF1 %s), cleared again",
                                (was_on & 1u) ? "ON" : "off", (was_on & 2u) ? "ON" : "off");
                    }
                }
                break;
            }
        }
        // The flag FIRST: dskchg_on_motor stores the time before the flag, so
        // a flag read first can never be newer than the time read after it --
        // never "on" with an old time, which the swap hold would force past.
        {
            const bool motor_on = dskchg_motor_on();
            g_motor_on_ms = dskchg_motor_on_ms();
            g_motor_on = motor_on;
            // Say when the published motor flag changes, and from what
            // (OTA stall, HANDOFF 2026-10-09). DF0's flag has TWO writers
            // after boot: mtr_pio_isr, from sel_mtr, which latches MTR on a
            // SEL0 FALL and holds it until a later SEL0 fall latches a
            // different level; and mtr_force_off, when the bus loses power
            // (above). The pads show the bus at the moment it is noticed.
            static int motor_logged = -1;
            if ((int)motor_on != motor_logged) {
                static char pads[96];
                bus_pads_str(pads, sizeof pads);
                wf_logf(WF_INFO, "motor: DF0 %s (%s) | %s", motor_on ? "ON" : "off",
                        motor_logged < 0 ? "boot value"
                        : motor_on       ? "sel_mtr latched MTR low on a SEL0 fall"
                        : motor_off_unpowered ? "bus unpowered: all pads low for 2 s"  // BUS_UNPOWERED_MS
                                              : "sel_mtr latched MTR high on a SEL0 fall",
                        pads);
                motor_logged = (int)motor_on;
                motor_off_unpowered = false;
            }
        }

        // The activity LED, the way a real drive's light is: lit while the
        // Amiga uses a drive this board serves -- selected and its motor on --
        // never for PaulaNET's cylinders in Network mode (led_activity.h has
        // the rule and the hold). Sampled here, once a pass: two pad reads and
        // a GPIO write, nothing in an ISR, nothing on the serving path. An
        // unpowered bus reads every select asserted; its motor latches are
        // cleared above, and it is never activity anyway.
        {
            static led_activity_t led_act;
            static bool led_act_init;
            if (!led_act_init) { led_activity_init(&led_act); led_act_init = true; }
            const uint8_t serving = df1_serving_mask(n_drives, bus_out_drive_enabled(1));
            bool busy = false;
            if (!g_bus_unpowered) {
                busy = led_drive_busy(!gpio_get(PIN_SEL0), dskchg_motor_on_d(0), false);
#if DF1_CAPABLE
#if WF_PNET_LOOP
                const bool df1_pnet = led_pnet_track(g_pnet_on, cur_cyl[1]);
#else
                const bool df1_pnet = false;
#endif
                if (serving & BUS_SEL_DF1)
                    busy = busy || led_drive_busy(!gpio_get(PIN_SEL1), dskchg_motor_on_d(1), df1_pnet);
#endif
            }
            (void)serving;
            led_set_activity(led_activity_step(&led_act, clock_ms(), busy));
        }

        // A write-protect flip on the same disk (g_reinsert_req's comment).
        // The decision itself is pure (reinsert.h, host-tested): idle (no
        // write applied OR merely attempted for REINSERT_IDLE_MS -- the later
        // of g_write_last_ms and g_wgate_last_ms), motor off and WGATE clear
        // -> announce; otherwise wait, unless the request has been pending
        // since before REINSERT_FORCE_MS, in which case it is forced through
        // rather than left to starve. Only the volatile reads and the
        // dskchg call live here.
        // Not during a swap's empty phase: an insert there would end it early.
        // The request waits, and the phase's own insert announces the disk.
        if (g_reinsert_req && disk_mounted && !swap_phase_empty(&df0_phase)) {
            uint32_t last_activity_ms = g_write_last_ms;
            if ((int32_t)(g_wgate_last_ms - last_activity_ms) > 0) {
                last_activity_ms = g_wgate_last_ms;
            }
            bool forced;
            if (reinsert_may_announce(clock_ms(), g_reinsert_raised_ms, dskchg_motor_on(),
                                       !gpio_get(PIN_WGATE), last_activity_ms, &forced)) {
                // Read-then-clear, not atomic: if core1 raises a NEW request
                // between the `if` above and this store, it is lost here.
                // Harmless -- core1 always stores the new WPROT pad state
                // before setting the flag (the "wprot:" site above), so the
                // announcement this triggers still conveys whatever is
                // newest on the pin, lost request or not.
                g_reinsert_req = false;
                dskchg_image_inserted();
                if (forced) {
                    wf_logf(WF_WARN, "reinsert: forced after %u ms pending "
                                      "(motor still on, or WGATE still asserted?)",
                            (unsigned)REINSERT_FORCE_MS);
                } else {
                    wf_logf(WF_INFO, "reinsert: /CHNG asserted until the next step (write-protect changed)");
                }
            }
        }

        bool now_mounted;
        if (track_cache_check_swap(&last_active_token, &now_mounted)) {
            g_reinsert_req = false;   // the mount/eject below announces this
            loaded = -1;
            const bool was_mounted = disk_mounted;
            disk_mounted = now_mounted;
            // One slot, computed once, for both HD decisions below: the
            // WF_VERIFY_TRACKS skip and the drive-ID choice used to read
            // psram_token_slot(last_active_token) and psram_active_slot()
            // respectively -- two different reads of what should be the
            // same slot at this instant (final-fix F6). (void) in case
            // neither consumer below is compiled in (WF_VERIFY_TRACKS=0 and
            // WF_DRIVE_ID=OFF together).
            const int slot = psram_active_slot();
            (void)slot;
#if WF_VERIFY_TRACKS
            // Sweep on mount only, and not an HD disk: its slot holds ADF,
            // which psram_image_read refuses; its encode is host-tested
            // against Greaseweazle (test_track_cache_hd.c).
            verify_next = now_mounted &&
                psram_image_slot_kind(slot) != SLOT_KIND_ADF_HD
                ? 0 : NUM_TRACKS;
            verify_bad = 0;
#endif
            // A disk over a disk (web mount, Next, NFC tap) is shown EMPTY
            // for SWAP_EMPTY_MS first, so trackdisk's change poll sees a
            // removal and, on a later poll, an insertion -- never both in one
            // poll, which swallowed the insertion and left "Please insert
            // volume" up until Retry (swap_phase.h). The swap gate already
            // ran on core1 before this slot was published. `was_mounted`
            // includes a disk still waiting out an empty phase: a second swap
            // restarts the timer, and the newest disk goes in.
            switch (swap_phase_on_change(&df0_phase, clock_ms(), was_mounted, now_mounted)) {
            case SWAP_PHASE_INSERT_NOW:
                df0_present(slot, last_active_token);
                break;
            case SWAP_PHASE_GO_EMPTY:
                df0_absent();
                wf_trace(WF_EV_EJECT, 0, 0);
                wf_logf(WF_INFO, "swap: DF0 shown empty for %u ms before the new disk",
                        (unsigned)SWAP_EMPTY_MS);
                break;
            case SWAP_PHASE_EJECT:
                df0_absent();
                wf_trace(WF_EV_EJECT, 0, 0);
                break;
            }
        }
        // The end of DF0's empty phase: the newest published disk goes in.
        // Read afresh -- a newer token would have restarted the phase above.
        if (swap_phase_insert_due(&df0_phase, clock_ms())) {
            loaded = -1;
            df0_present(psram_active_slot(), last_active_token);
            wf_logf(WF_INFO, "swap: DF0 new disk inserted (/CHNG until the next step)");
        }

#if DF1_CAPABLE
        // DF1. The setting first (df1_live.h): a live switch from core1. Read the
        // seq, then the values it names; publish applied = that seq last. A
        // newer handoff landing meanwhile has a newer seq and is applied next
        // pass, so a torn read is never the one acknowledged.
        if (g_df1_req_seq != g_df1_applied_seq) {
            const uint32_t s = g_df1_req_seq;
            __dmb();
            const df1_mode_t m = (df1_mode_t)g_df1_req_mode;
            const uint32_t version = g_drive_req_version;
            const df1_live_t p = df1_live_apply(m, bus_out_drive_enabled(1));
            g_df1_mode = m;          // the STEP/MTR ISRs and the mount below read it
#if WF_PNET_LOOP
            pnet_set_mode(m);        // Phase 3: the gate, before the lines and the mount below read it
#endif
            if (p.unmount) {
                stream_stop(1);
                loaded1 = -1;
                df1_mounted = false;
                swap_phase_cancel(&df1_phase);   // no insert after the drive went away
            }
            if (p.set_id) bus_out_drive_id_set(1, p.id);
            if (p.lines) {
                bus_out_set_drive(1, PIN_WPROT, true);
#if WF_PNET_LOOP
                // A head already on cylinder 77 gets the loopback's WPROT now, not at its next step.
                if (g_pnet_on) bus_out_set_drive(1, PIN_WPROT, pnet_df1_wprot(cur_cyl[1]));
#endif
                bus_out_set_drive(1, PIN_TRK0, cur_cyl[1] == 0);
            }
            if (p.eject) dskchg_image_ejected_d(1);
            // Last: the machines start with the ID, word and RDY level above
            // already in them (bus_out_drive_enable). Never a live disable:
            // parked keeps them running (df1_live.h).
            if (p.enable) bus_out_drive_enable(1, true);
            if (p.rescan) df1_rescan = true;
            drive_store_rec.version = version;
            drive_store_rec.mode = (uint8_t)m;
            drive_store_pending = true;
            drive_save_retry_at = clock_ms();   // a new record gets a fresh try
            __dmb();
            g_df1_applied_seq = s;
            wf_logf(WF_INFO, "df1: setting %lu applied -- %s", (unsigned long)version,
                    m != DF1_MODE_OFF ? (m == DF1_MODE_NET ? "on (Network), an empty DD drive until the driver disk is in"
                                                           : "on, an empty DD drive until the next disk is in")
                    : p.parked ? "parked: ID none, an empty write-protected drive until the board reboots"
                               : "off (already)");
        }
        // Then DF1's word: core1 published a new one (dc_df1_reconcile, or
        // the eject psram_publish_slot makes when DF0 takes DF1's slot). Stop
        // the old stream FIRST, then acknowledge -- the ack is core1's licence
        // to overwrite the slot (df1_quiesce_wait). DF1's lines move only
        // while DF1 is on: an off or parked DF1 stays as it is whatever is
        // published (core1 publishes nothing to it then -- dc_df1_want).
        {
            const int32_t t = psram_df1_token();
            if (t != df1_seen_tok || df1_rescan) {
                df1_rescan = false;
                df1_seen_tok = t;
                stream_stop(1);
                loaded1 = -1;
                const int ds = psram_token_slot(t);
                const bool hd = ds != SLOT_NONE && psram_image_slot_kind(ds) == SLOT_KIND_ADF_HD;
                const bool was_mounted = df1_mounted;
                df1_mounted = ds != SLOT_NONE && (!hd || DF1_HOLDS_HD) && g_df1_mode != DF1_MODE_OFF;
                // A disk over a disk: DF1 empty first, as for DF0 (swap_phase.h).
                const swap_phase_action_t act =
                    swap_phase_on_change(&df1_phase, clock_ms(), was_mounted, df1_mounted);
                if (act == SWAP_PHASE_INSERT_NOW) {
                    // The ID before the insert is announced, as for DF0.
                    bus_out_drive_id_set(1, hd ? DRIVE_ID_KIND_HD : DRIVE_ID_KIND_DD);
                    dskchg_image_inserted_d(1);
                    wf_trace(WF_EV_MOUNT, (uint32_t)t, 1);
                } else if (act == SWAP_PHASE_GO_EMPTY) {
                    bus_out_drive_id_set(1, DRIVE_ID_KIND_DD);   // an empty DD drive
                    dskchg_image_ejected_d(1);
                    wf_trace(WF_EV_EJECT, 0, 1);
                    wf_logf(WF_INFO, "swap: DF1 shown empty for %u ms before the new disk",
                            (unsigned)SWAP_EMPTY_MS);
                } else if (g_df1_mode != DF1_MODE_OFF) {
                    bus_out_drive_id_set(1, DRIVE_ID_KIND_DD);   // an empty DD drive
                    dskchg_image_ejected_d(1);
                    if (was_mounted) wf_trace(WF_EV_EJECT, 0, 1);
                }
                psram_df1_reader_ack(t);
            }
        }
        // The end of DF1's empty phase: the disk its word names now goes in
        // (a newer word restarted the phase above; a switch off cancelled it).
        if (swap_phase_insert_due(&df1_phase, clock_ms()) && df1_mounted) {
            const int ds = psram_token_slot(df1_seen_tok);
            const bool hd = ds != SLOT_NONE && psram_image_slot_kind(ds) == SLOT_KIND_ADF_HD;
            loaded1 = -1;
            bus_out_drive_id_set(1, hd ? DRIVE_ID_KIND_HD : DRIVE_ID_KIND_DD);
            dskchg_image_inserted_d(1);
            wf_trace(WF_EV_MOUNT, (uint32_t)df1_seen_tok, 1);
            wf_logf(WF_INFO, "swap: DF1 new disk inserted (/CHNG until the next step)");
        }
#endif

        /*
         * REVERTED 2026-09-13, the same day it was written.
         *
         * This briefly sampled the SIDE pin here and required it to be stable
         * for one iteration, instead of taking want_track from the ISR. The
         * reasoning looked sound -- SIDE is a level the host holds, not a
         * pulse, and 3,725 edges under 1 ms apart had been measured -- but the
         * board went from booting Workbench reliably to reporting "not a DOS
         * disk", and that is the only change between those two states.
         *
         * Two lessons, both mine. The bounce measurement came from a log that
         * had silently dropped 2,091 records, so the number it rested on was
         * never trustworthy. And the read errors it was meant to cure survived
         * it, which should have been enough to revert immediately rather than
         * leave a speculative change in the real-time path while hunting
         * something else.
         *
         * If SIDE really does bounce, fix it where it can be proven: debounce
         * in the ISR against a measured threshold, on a log verified to have
         * dropped nothing.
         */
        // Nothing streams from DF0 while a swap shows it empty (swap_phase.h).
        if (!swap_phase_empty(&df0_phase)) serve_drive(0, psram_active_token(), &loaded);
#if DF1_CAPABLE
        // DF1 only while its word names a disk it holds: an empty DF1 streams
        // nothing (its want_track still follows its head).
#if WF_PNET_LOOP
        g_pnet_df1_mounted = df1_mounted && !swap_phase_empty(&df1_phase) && g_pnet_on;
        if (g_pnet_on) {
            // A finished batch first: its echo may be read next. A commit while the head is already
            // on side 1 (SIDE flipped since the capture ended) rebuilds the echo there.
            // Only an echo already served needs the -1: any other loaded1 differs from 155 anyway,
            // and keeping it lets pnet_serve_df1 see a side return as one (restart-by-cause count).
#if PNET_SIDE_DELAY_US
            if (g_pnet_go_rearm) { g_pnet_go_rearm = false; loaded1 = -1; }   // a skipped delayed start: serve afresh
#endif
            if (pnet_take_capture()) {
                if (want_track[1] == PNET_TRACK_OUT && loaded1 == PNET_TRACK_OUT) {
                    loaded1 = -1;
                    g_pnet_rst_commit = true;
                }
                // Build the echo now, not at the SIDE edge. Only with DF1 on cylinder 77 (154, 155,
                // or a restart pending): stopping a disk track's stream would leave it stopped.
                if (df1_mounted && (loaded1 == PNET_TRACK_IN || loaded1 == PNET_TRACK_OUT || loaded1 == -1
#if WF_PNET_L2
                                    || loaded1 == PNET_TRACK_STATUS - 1     // 152: side 0 of cylinder 76, nothing streams
#endif
                                    ))
                    pnet_prepare_echo();
#if WF_PNET_L2
                // 153: the status loop streams from g_pnet_status_words, but pnet_prepare_echo would stream_stop it
                // and leave loaded1 == want (nothing restarts it). Drop the old batch instead: the move to 155
                // builds a fresh one.
                else if (df1_mounted && loaded1 == PNET_TRACK_STATUS)
                    g_pnet_prepared = false;
#endif
            }
#if WF_PNET_L2
            // Frames came while nothing is out and the head sits on side 0 (the Amiga between its write
            // and its read, or idle there): build the batch now, before the Amiga turns to side 1 -- a
            // build at the SIDE edge is late (Phase 0, 0c89f65). Never while side 1 streams: that would
            // tear the read in progress. Nor during the Amiga's write (WGATE asserted, a DF1 write ours)
            // or with its capture armed or not yet taken: the build would postpone that take by a whole
            // build, and the commit would then rebuild the same batch (review fix 1).
            if (df1_mounted && loaded1 == PNET_TRACK_IN && !g_link.backup && pnet_ring_count(&g_pnet_rx) != 0 &&
                !pnet_raw_pending && !pnet_write_ours && gpio_get(PIN_WGATE))
                pnet_prepare_echo();
            {
                const uint32_t hf = heap_free_bytes();
                if (hf < g_pnet_heap_low) g_pnet_heap_low = hf;
            }
            pnet_l2_log();
#endif
        }
        if (df1_mounted && !swap_phase_empty(&df1_phase)) {   // nothing streams while a swap shows DF1 empty
            if (g_pnet_on) pnet_serve_df1(df1_seen_tok, &loaded1);
            else serve_drive(1, df1_seen_tok, &loaded1);
        }
        // Off or Next: a pre-arm left from Network mode is still let go; nothing new is armed (Review Focus 4).
        // After the take: a taken batch frees the capture.
        if (g_pnet_on || flux_capture_prearmed()) pnet_prearm_step();
        if (g_pnet_on) pnet_log_summary();
#else
        if (df1_mounted && !swap_phase_empty(&df1_phase)) serve_drive(1, df1_seen_tok, &loaded1);
#endif
#endif

        // HD spec §7 step 10: the free-heap low-water mark, logged each time
        // it drops (sampled every 5 s, so a transient dip can be missed --
        // it is a floor for the bench, not a guarantee).
        {
            static uint32_t heap_low = UINT32_MAX, heap_checked_ms;
            if (clock_ms() - heap_checked_ms >= 5000u) {
                heap_checked_ms = clock_ms();
                const uint32_t f = heap_free_bytes();
                // tls held/peak alongside: what one connection really costs,
                // measured (tls_mem.h), rather than computed from the config.
                tls_mem_stats_t m;
                tls_mem_stats(&m);
                if (f < heap_low) {
                    heap_low = f;
                    wf_logf(WF_INFO, "heap: free low-water %lu bytes (tls held %lu peak %lu)",
                            (unsigned long)f, (unsigned long)m.held, (unsigned long)m.peak);
                }
                // A failed mbedTLS allocation, wherever it happened (poll,
                // upload, OTA). The low-water line above cannot show one: a
                // refused sbrk leaves the break where it was. wf_tls_calloc
                // runs in lwIP's IRQ too, so it only counts; saying so is here.
                static uint32_t tls_fails_seen;
                if (m.fails != tls_fails_seen) {
                    tls_fails_seen = m.fails;
                    wf_logf(WF_WARN, "tls: %lu alloc fail(s), last %lu B; held=%lu peak=%lu free>=%lu",
                            (unsigned long)m.fails, (unsigned long)m.last_fail_bytes,
                            (unsigned long)m.held, (unsigned long)m.peak, (unsigned long)f);
                }
            }
        }

        /*
         * Write capture. Two bounded steps, both of which do nothing at all
         * unless the Amiga is writing.
         *
         * A whole, clean track is applied to the board's copy of the disk
         * (write-back spec §2); anything else is rejected and logged. Applying
         * it marks the track dirty (psram_image.h) and bumps g_write_gen --
         * core1's uploader (uploader.c, driven from core1_main) is what
         * notices that and gets the track to the server, so a write no longer
         * needs the board to stay powered and mounted to survive.
         *
         * Re-serving a rewritten track restarts the stream mid-revolution: one
         * torn revolution if the Amiga reads that track at that instant, which
         * trackdisk retries. It has just finished writing it, so it rarely is.
         */
        flux_capture_poll();
        if (flux_capture_timeout(clock_ms())) {
#if WF_PNET_LOOP
            pnet_raw_pending = false;            // an abandoned raw capture is not waiting
            // A timed-out DF1 write must not leave the pnet branch owning the next WGATE release
            // (final review M3) -- unless the ISR has armed a new capture since the timeout, whose
            // flags these then are: checked with interrupts off so no arm lands in between.
            {
                const uint32_t irq = save_and_disable_interrupts();
                if (flux_capture_idle()) {
                    pnet_write_ours = false;
                    pnet_armed_this_write = false;
                }
                restore_interrupts(irq);
            }
#endif
            // Almost always the Amiga powering off: its outputs stop driving,
            // the buffer inputs float, and WGATE reads as asserted forever.
            wf_logf(WF_WARN, "write: WGATE asserted for over %u ms -- not a write, "
                             "capture abandoned (is the Amiga powered off?)",
                    (unsigned)FLUX_CAPTURE_MAX_MS);
        }
        {
            flux_capture_result_t cap;
            // Fewer intervals than one sector's worth of the longest legal gap
            // cannot hold a sector. What produces them is WGATE (pulled up to the
            // Amiga's own +5 V) falling and rising with the Amiga's power, not a
            // write: a real track is 48,000-54,000 intervals (2026-09-15).
            const uint32_t min_write_intervals = MFM_SECTOR_MFM_BYTES * 8u / 4u;
            const bool took = flux_capture_take(&cap);
            if (took && cap.intervals < min_write_intervals) {
                wf_logf(WF_INFO, "write: WGATE pulse, %u intervals, not a write",
                        (unsigned)cap.intervals);
            } else if (took) {
                // Snapshot: write_track/write_token are volatile and gpio_isr
                // rewrites both the instant the Amiga asserts WGATE for the
                // NEXT track (e.g. the other head, same cylinder). Re-reading
                // them across this branch could decode/log one track but
                // apply under another's number. Everything below uses only
                // wt/wtok, never write_track/write_token directly.
                const int     wt   = write_track;
                const int32_t wtok = write_token;
                // HD writes spec §4.2: the mounted disk's sector count -- the
                // disk WGATE wrote to (wtok), never what the data looks like.
                const unsigned nsec = write_back_sectors(wtok);
                const uint32_t want = write_back_mask(nsec);
                static uint8_t decoded[MFM_HD_TRACK_DATA_BYTES];
                mfm_decode_result_t d;
                memset(decoded, 0, sizeof decoded);
                // Final review F2: the decode's own time, for the bench -- an
                // HD capture is twice a DD one (~6-7 ms expected), and core0
                // serves no read while it runs.
                const uint64_t dec_t0 = time_us_64();
                mfm_decode_track_n(cap.mfm, cap.mfm_bytes, decoded, &d, nsec);
                const unsigned long dec_us = (unsigned long)(time_us_64() - dec_t0);
#if WF_PNET_LOOP
                // Nothing below reads cap.mfm (decoded[] is its own buffer): a DF1 batch may arm
                // over mfm_buf again (flux_capture_idle; final review, Important 1).
                flux_capture_done();
#endif
                wf_logf(WF_INFO,
                        "write: trk %d %u iv %u B sec 0x%06lx/%u%s bad %u foreign %u rng %u "
                        "dec %lu us%s",
                        wt,
                        (unsigned)cap.intervals, (unsigned)cap.mfm_bytes,
                        (unsigned long)d.found, nsec,
                        d.found == want ? " ALL" : " PART",
                        (unsigned)d.bad_checksums, (unsigned)d.foreign_sectors,
                        (unsigned)cap.out_of_range, dec_us,
                        cap.overflowed ? " OVERFLOWED" : "");
                wf_logf(WF_INFO, "write: first id %u sync@%lu, last id %u end@%lu, of %lu bits",
                        (unsigned)d.first_id, (unsigned long)d.first_sync_bit,
                        (unsigned)d.last_id, (unsigned long)d.last_end_bit,
                        (unsigned long)cap.mfm_bytes * 8ul);
                wf_logf(WF_INFO, "write: backlog %u/4096 gap %u ms ns %u-%u cells %u/%u/%u short %u",
                        (unsigned)cap.max_backlog, (unsigned)cap.max_poll_gap_ms,
                        (unsigned)cap.ns_min, (unsigned)cap.ns_max,
                        (unsigned)cap.cells[0], (unsigned)cap.cells[1], (unsigned)cap.cells[2],
                        (unsigned)cap.glitches);
                // HANDOFF 3av: the capture's first word (`lead`, the arm-to-
                // first-edge time, NOT counted in the line above) and where the
                // shortest real interval sat. Its own line: the one above is
                // near WF_LOG_MSG (88) already.
                wf_logf(WF_INFO, "write: lead %u ns, shortest %u ns at word %u of %u",
                        (unsigned)cap.lead_ns, (unsigned)cap.ns_min,
                        (unsigned)cap.min_at, (unsigned)cap.intervals);
                if (d.found && !d.track_no_consistent) {
                    wf_logf(WF_WARN, "write: sector headers disagree about the track");
                } else if (d.found && d.track_no != wt) {
                    // The one corruption a checksum cannot see: every sector
                    // internally valid, but written to a cylinder the head is
                    // not on. Never apply one of these.
                    wf_logf(WF_WARN, "write: track says %u, head is on %d",
                            (unsigned)d.track_no, wt);
                }
                {
                    const uint64_t t0 = time_us_64();
                    const int32_t now_tok = psram_active_token();
                    const wb_verdict_t v = write_back_verdict(&d, wt, cap.overflowed,
                                                              wtok, now_tok);
                    if (v != WB_APPLY) {
                        wf_logf(WF_WARN, "write: trk %d rejected: %s",
                                wt, write_back_reason(v, nsec));
                    } else {
                        // Final review F1: g_write_gen goes odd BEFORE the
                        // store's first byte and even only after the track is
                        // DIRTY and last_ms is set, so core1's close never
                        // hashes a half-copied track (up_close has the
                        // interleavings). A failed apply still moves it by two:
                        // the close is retried once, harmlessly.
                        write_back_gen_begin(&g_write_gen);
                        const bool ok = write_back_apply(psram_token_slot(now_tok), wt, decoded);
                        if (ok) g_write_last_ms = clock_ms();
                        write_back_gen_end(&g_write_gen);
                        if (ok) {
                            // The SRAM copy is keyed on (track, token) and a
                            // write changes neither: drop it, and if the head is
                            // still on this track re-serve it now rather than at
                            // the next seek.
                            track_cache_invalidate(wt);
                            if (loaded == wt) loaded = -1;
                            const uint64_t us = time_us_64() - t0;
                            wf_logf(WF_INFO, "write: trk %d applied in %lu us",
                                    wt, (unsigned long)us);
                        } else {
                            wf_logf(WF_ERR, "write: trk %d apply failed (PSRAM)", wt);
                        }
                    }
                }
            }
#if WF_PNET_LOOP
            // Every other path, the short "WGATE pulse" one included: a take is never left held.
            // (A no-op when nothing was taken or the decode above already released it.)
            flux_capture_done();
#endif
        }

#if WF_VERIFY_TRACKS
        // An ADF_HD slot holds sector data, not MFM: psram_image_read
        // refuses it, and its tracks are encoded on read (track_cache.c),
        // so there is nothing stored to decode. Say so once rather than
        // report 160 unreadable tracks.
        if (verify_next < NUM_TRACKS &&
            psram_image_slot_kind(psram_active_slot()) == SLOT_KIND_ADF_HD) {
            verify_next = NUM_TRACKS;
            wf_logf(WF_INFO, "verify: HD slot: verify skipped, tracks are encoded on read");
        }
        if (verify_next < NUM_TRACKS) {
            static uint8_t vmfm[TRACK_MAX_BYTES];
            static uint8_t vdec[MFM_TRACK_DATA_BYTES];
            const int t = verify_next++;
            uint32_t bits = 0;
            const int slot = psram_active_slot();
            if (slot >= 0 && psram_image_read(slot, t, vmfm, &bits)) {
                mfm_decode_result_t d;
                memset(vdec, 0, sizeof vdec);
                mfm_decode_track(vmfm, (bits + 7u) / 8u, vdec, &d);
                if (d.found != 0x7ff || d.bad_checksums || d.track_no != t) {
                    verify_bad++;
                    wf_logf(WF_ERR, "verify: track %d BAD -- sectors 0x%03x (want 0x7ff), "
                                    "bad-cksum %u, header says track %u, %lu bits",
                            t, (unsigned)d.found, (unsigned)d.bad_checksums,
                            (unsigned)d.track_no, (unsigned long)bits);
                }
            } else {
                verify_bad++;
                wf_logf(WF_ERR, "verify: track %d could not be read from PSRAM", t);
            }
            if (verify_next == NUM_TRACKS) {
                wf_logf(verify_bad ? WF_ERR : WF_INFO,
                        "verify: swept 160 tracks from PSRAM, %u bad", (unsigned)verify_bad);
            }
        }
#endif

#if DF1_CAPABLE
        // The DF1 setting's flash record (R17, final review C1). Written when
        // BOTH drives are empty (D3, the display record's rule) OR when the
        // Amiga is idle with a disk mounted. Empty alone was not enough: a
        // board powered by the Amiga holds a disk from its first poll, so a
        // setting changed then never reached flash, and the next power-on
        // answered with the old mode -- in the OFF direction, the very case a
        // real external DF1 is plugged in for.
        //
        // Idle (drive_store_idle, host-tested): the swap gate's test
        // (swap_gate.h) -- no write applied or attempted and no WGATE edge
        // for SWAP_IDLE_MS, WGATE clear -- plus EITHER drive's motor off for
        // SWAP_IDLE_MS (DF1's too, so DF1 is not mid-stream), and nothing
        // captured but unsent (up_holds, published by core1 as g_up_holds).
        //
        // Why the ~45 ms flash_safe_execute lockout is acceptable then (core0's
        // interrupts off, core1 parked):
        //   - No read is under way: both motors are off, and the Amiga reads
        //     only with the motor on. A new access first switches the motor on
        //     and then waits for the drive to spin up (trackdisk waits for RDY,
        //     hundreds of ms), far longer than the lockout. No steps are
        //     expected while idle either.
        //   - MTR and SEL are latched by PIO state machines (sel_mtr, the
        //     status gate), not by core0: a motor-on during the lockout is held
        //     in sel_mtr's FIFO and handled by mtr_pio_isr straight after, and
        //     RDY/CHNG/WPROT/TRK0 keep being driven by the status gate.
        //   - A step that does come (Kickstart's empty-drive click poll on an
        //     empty DF1: a pulse or two every few seconds) is held in
        //     step_dir's RX FIFO with its DIR and drained by step_pio_isr after.
        //   - These are the same conditions the empty-drive store has always
        //     run under (the display record), where the Amiga is equally free
        //     to switch a motor on.
        // A residual risk -- a motor-on edge inside the 45 ms followed by a
        // read faster than the lockout -- shows on the bench as a read error
        // (Task 24's store step), not as a corrupted disk: nothing is written.
        //
        // Here, in core0's loop, a slot core1 publishes after this check is not
        // served until this pass is over (track_cache_check_swap, above), so a
        // disk change cannot land under the write. A failed save waits 5 s, not
        // one loop turn -- each try parks core1.
        {
            const bool motor_any = dskchg_motor_on_d(0) || dskchg_motor_on_d(1);
            if (motor_any) drive_motor_seen_ms = clock_ms();
        }
        if (drive_store_should_write(drive_store_pending,
                                     !disk_mounted && psram_active_slot() == SLOT_NONE && !df1_mounted,
                                     drive_store_idle(clock_ms(),
                                                      dskchg_motor_on_d(0) || dskchg_motor_on_d(1),
                                                      !gpio_get(PIN_WGATE),
                                                      // motor_on=true only folds the third time in
                                                      swap_gate_last_activity(g_write_last_ms, g_wgate_last_ms,
                                                                              true, drive_motor_seen_ms),
                                                      g_up_holds)) &&
            (int32_t)(clock_ms() - drive_save_retry_at) >= 0) {
            if (drive_store_save(&drive_store_rec)) {
                drive_store_pending = false;
                wf_logf(WF_INFO, "df1: setting %lu stored", (unsigned long)drive_store_rec.version);
            } else {
                drive_save_retry_at = clock_ms() + 5000u;
                wf_logf(WF_WARN, "df1: storing setting %lu failed -- retry in 5 s",
                        (unsigned long)drive_store_rec.version);
            }
        }
#endif

        // OLED layouts: a display core1 fetched and validated. Applied here,
        // in the display slot, before this pass renders.
        {
            static display_slot_t in;   // static: a layout plus a record, ~250 bytes
            if (display_handoff_take(&display_seen, &in)) {
                display_apply(&in);
                display_rerender = true;
                display_save_failed = false;   // a new record gets a fresh try
            }
        }
        // ...and its flash record, deferred to a moment the drive is empty
        // (display_store.h). Here, in core0's loop: a slot core1 publishes
        // after this check is not served (track_cache_check_swap, above) until
        // this pass is over, so the write can never run under a disk the Amiga
        // is reading. Both views of "empty" are checked: core0's own
        // (disk_mounted) and the published slot, which display_store_save
        // checks again itself. A failed save waits 10 s, not one loop turn --
        // flash_safe_execute parks core1 every time it is tried.
        if (display_store_should_write(g_display_store_pending,
                                       disk_mounted || psram_active_slot() != SLOT_NONE) &&
            (!display_save_failed || (int32_t)(clock_ms() - display_save_retry_at) >= 0)) {
            if (display_store_save(&g_display_rec)) {
                g_display_store_pending = false;
                display_save_failed = false;
                wf_logf(WF_INFO, "display: version %lu stored", (unsigned long)g_display_rec.version);
            } else {
                display_save_failed = true;
                display_save_retry_at = clock_ms() + 10000u;
                wf_logf(WF_WARN, "display: storing version %lu failed -- retry in 10 s",
                        (unsigned long)g_display_rec.version);
            }
        }

        // The display: composed here because the track counter is core0's
        // alone, and pushed a bounded slice at a time because a whole frame
        // is ~11 ms against this loop's 1 ms turn. See the display section at
        // the top of this file for why core1 cannot own this.
        if (ui_snapshot(&ui, ui_tag, &ui_tag_at, &ui_tag_n)) {
            // A tap's line for 3 s, else "Tap tag to write" while armed, else
            // the observer's own line (nfc_ui_detail); and while armed, the
            // disk to be written on the title line (nfc_ui_title).
            const bool tag_live = nfc_tag_clock_live(&ui_tag_clock, ui_tag_n, ui_tag_at, clock_ms());
            const char *d = nfc_ui_detail(ui.detail, ui_tag, tag_live, &nfc_armed);
            if (d != ui.detail) snprintf(ui.detail, sizeof ui.detail, "%s", d);
            const char *t = nfc_ui_title(ui.title, &nfc_armed);
            if (t != ui.title) snprintf(ui.title, sizeof ui.title, "%s", t);
            ui.show_track = disk_mounted;
            // The NFC element (1.10.0): an armed write first -- it is the one
            // reader state that waits on a person -- then the reader's level
            // as core0's own nfc_step last saw it (0 = not checked yet draws
            // as absent).
            ui.nfc = nfc_armed.armed ? DISP_NFC_ARMED
                   : g_nfc_reader == 1 ? DISP_NFC_PRESENT : DISP_NFC_ABSENT;
            ui.cyl        = cur_cyl[0];
            // The track counter side arrow (1.18.0): SIDE is one bus line for every
            // drive, so this is the side DF0's head reads too.
            ui.side       = (uint8_t)(cur_side ? 1 : 0);
            ui.max_cyl    = NUM_CYL - 1;
            // The lemming walks off core0's own clock, which is the point of
            // it: every other field on this panel is static between events, so
            // a hung board and an idle one look identical. A lemming that has
            // stopped walking is a service loop that has stopped turning.
            ui.tick       = (int)(clock_ms() / LEMMING_STEP_MS);
            // Re-render only on a real change. display_render() is cheap but
            // it is not free, and this loop runs a thousand times a second
            // while nothing at all is happening.
            // A new layout (or panel) re-renders even an unchanged state.
            if (display_rerender || memcmp(&ui, &last_ui, sizeof ui) != 0) {
                display_set(&g_disp, &ui);
                last_ui = ui;
                display_rerender = false;
            }
        }
        // One bus user per pass (spec §4.1): the panel when it has bytes
        // queued, otherwise the tag reader, whose nfc_step caps itself at
        // NFC_MAX_OPS_PER_STEP register operations -- 1 while a disk is
        // mounted on a panel-less (100 kHz) bus.
        //
        // Gated on display_in_sync, not on display_pump's return: that is the
        // bytes SENT, and it is 0 both when there was nothing to send and when
        // the blit failed -- and a failed blit has already used the bus this
        // pass. A panel whose blits keep failing (a loose lead) is given every
        // other pass, so it cannot starve the reader either.
        if (g_panel_addr != 0 && !display_in_sync(&g_disp) && !pump_failed) {
            pump_failed = display_pump(&g_disp, disk_mounted ? DISP_BUDGET_MOUNTED
                                                             : DISP_BUDGET_IDLE) == 0;
        } else {
            pump_failed = false;
            nfc_core0_step(&nfc_armed, disk_mounted && g_panel_addr == 0);
        }

        {
            static uint32_t reported_rejects;
            uint32_t r = steps_rejected;
            if (r != reported_rejects) {
                reported_rejects = r;
                wf_logf(WF_WARN, "step: %lu pulse(s) rejected as too fast (<%u us apart) "
                                 "-- electrical noise, not a seek",
                        (unsigned long)r, (unsigned)STEP_MIN_INTERVAL_US);
            }
            // At most every 10 s, and only while steps are arriving. A zero is
            // a result too: it says interrupt latency never exceeded DIR's
            // hold time in that stretch, so say it rather than stay silent.
            static uint32_t reported_seen, reported_at_ms;
            uint32_t n = steps_seen;
            if (n != reported_seen && clock_ms() - reported_at_ms >= 10000) {
                reported_seen = n; reported_at_ms = clock_ms();
                wf_logf(WF_INFO, "step: %lu pulses; an interrupt-time DIR read "
                                 "would have been wrong on %lu",
                        (unsigned long)n, (unsigned long)steps_dir_late);
            }
            // Another drive's traffic, ignored. Summarised rather than traced
            // per pulse: a DF1 recalibrate is 80 steps in 0.4 s, and one
            // record each would flood the ring.
            static uint32_t reported_other_steps, reported_other_writes, other_at_ms;
            uint32_t os = steps_other_drive, ow = writes_other_drive;
            if ((os != reported_other_steps || ow != reported_other_writes) &&
                clock_ms() - other_at_ms >= 10000) {
                reported_other_steps = os; reported_other_writes = ow;
                other_at_ms = clock_ms();
                wf_logf(WF_INFO, "sel0: ignored %lu step(s) and %lu write(s) "
                                 "for another drive",
                        (unsigned long)os, (unsigned long)ow);
            }
            {
                // Only on change: both readings are stable once true.
                static bool sel1_printed; static bool prev_wired; static uint32_t prev_steps;
                const bool w = g_sel1_wired; const uint32_t ds = g_df1_steps;
                if (!sel1_printed || w != prev_wired || ds != prev_steps) {
                    sel1_printed = true; prev_wired = w; prev_steps = ds;
                    wf_logf(WF_INFO, "sel1: wired %s, df1 steps %lu",
                            w ? "yes" : "no", (unsigned long)ds);
                }
            }
#if WF_BUS_SNIFF
            static uint32_t reported_violations;
            if (sniff_violations != reported_violations) {
                reported_violations = sniff_violations;
                wf_logf(WF_ERR, "sniff: %lu sample(s) with a status output asserted "
                                "while SEL0 was released",
                        (unsigned long)sniff_violations);
            }
            static uint32_t reported_gaps;
            if (sniff_gaps != reported_gaps) {
                reported_gaps = sniff_gaps;
                wf_logf(WF_WARN, "sniff: PIO FIFO overflowed %lu time(s) in %lu records",
                        (unsigned long)sniff_gaps, (unsigned long)sniff_records);
            }
#endif
        }

#if !WF_FW_DEBUG
        // The "wf server" / "wf reboot" console (1.13.0, spec §3). Only when
        // WF_FW_DEBUG is off: the debug build's fwdbg reader on core1 owns
        // stdin, and two readers would each get half of every line. Here on
        // core0 because the flash writes it makes must not run under a disk
        // (refused below), the same judgement the store writes above make.
        // Non-blocking: costs one empty getchar when nothing is typed.
        {
            static sc_state_t con;
            static bool con_init;
            if (!con_init) { sc_init(&con); con_init = true; }
            // Set once a reboot is requested: fw_rom_request_reboot() only
            // flags it, so without this a pasted second line would still run
            // (and against the stale g_server). The rest stays unread; the reboot
            // happens at the top of the next main-loop iteration.
            static bool con_reboot_pending;
            int ch;
            while (!con_reboot_pending && (ch = getchar_timeout_us(0)) != PICO_ERROR_TIMEOUT) {
                sc_cmd_t cmd;
                if (!sc_feed_char(&con, ch, &cmd)) continue;
                const bool custom = server_is_custom(&g_server, WEBADF_HOST);
#if DF1_CAPABLE
                const bool df1_in = df1_mounted;
#else
                const bool df1_in = false;
#endif
                const bool a_disk_is_in = disk_mounted || psram_active_slot() != SLOT_NONE || df1_in;
                server_override_t rec;
                switch (cmd.kind) {
                case SC_SHOW:
                    // Host last, as at boot: a long host is what gets cut, not the mode.
                    wf_logf(WF_INFO, "server: %s tls=%s %s", custom ? "custom" : "default",
                            g_server.tls == OVR_TLS_NOVERIFY ? "noverify" : "verify", g_server_hdr);
                    break;
                case SC_ASK:
                    wf_logf(WF_INFO, "server: %s", cmd.text);
                    break;
                case SC_ERROR:
                    wf_logf(WF_WARN, "server: %s", cmd.text);
                    break;
                case SC_SET: case SC_CLEAR: case SC_TLS:
                    // A flash write stalls XIP, which the disk image's
                    // neighbours run from; the store does not check (override_store.h).
                    if (a_disk_is_in) {
                        wf_logf(WF_WARN, "server: eject the disk first -- nothing changed");
                        break;
                    }
                    if (cmd.kind == SC_TLS) {
                        if (!override_store_load(&rec)) {
                            wf_logf(WF_WARN, "server: set a server first (wf server set https://...)");
                            break;
                        }
                        rec.tls = cmd.tls;
                        if (!override_store_save(&rec)) {
                            wf_logf(WF_WARN, "server: storing failed -- nothing changed");
                            break;
                        }
                        wf_logf(WF_INFO, "server: tls=%s stored -- applies at the next boot (wf reboot)",
                                cmd.tls == OVR_TLS_NOVERIFY ? "noverify" : "verify");
                    } else {   // SC_SET or SC_CLEAR
                        // `set` naming the default server is a `clear`: an
                        // override equal to the default would only re-enable
                        // `wf server tls` against it.
                        const bool to_default = cmd.kind == SC_CLEAR ||
                            server_is_default_target(cmd.host, cmd.port, WEBADF_HOST);
                        if (to_default) {
                            if (!override_store_load(&rec)) {
                                wf_logf(WF_INFO, "server: already the default");
                                break;
                            }
                        } else {
                            if (strcmp(cmd.host, g_server.host) == 0 && cmd.port == g_server.port) {
                                wf_logf(WF_INFO, "server: unchanged");
                                break;
                            }
                            memset(&rec, 0, sizeof rec);
                            snprintf(rec.host, sizeof rec.host, "%s", cmd.host);
                            rec.port = cmd.port;
                            rec.tls  = OVR_TLS_VERIFY;
                        }
                        // A pairing belongs to the server that issued it, so
                        // forget it FIRST and prove it is gone before the
                        // server changes. config_store_erase() is void and
                        // can silently do nothing (a slot core1 published
                        // since the disk check above, a flash_safe_execute
                        // timeout); saving the override first would then
                        // reboot onto the new host still holding the old
                        // server's bearer token. Static: core0's stack is small.
                        config_store_erase();
                        static char left_token[TOKEN_STORE_MAX_LEN + 1];
                        static device_config_t left_cfg;
                        if (token_store_load(left_token, sizeof left_token) ||
                            config_store_load(&left_cfg)) {
                            memset(left_token, 0, sizeof left_token);
                            memset(&left_cfg, 0, sizeof left_cfg);
                            wf_logf(WF_ERR, "server: forgetting the pairing failed -- nothing changed");
                            break;
                        }
                        // Now the server. If this fails the board is still
                        // unpaired, which is safe whichever server is stored:
                        // it reboots into setup and pairs with that one. So
                        // say so and reboot anyway rather than sit unpaired.
                        bool stored;
                        if (to_default) {
                            override_store_erase();
                            server_override_t check;
                            stored = !override_store_load(&check);
                        } else {
                            stored = override_store_save(&rec);
                        }
                        if (!stored) {
                            wf_logf(WF_WARN, "server: storing failed -- the pairing is already "
                                             "forgotten, rebooting into setup");
                        } else if (to_default) {
                            wf_logf(WF_WARN, "server: back to the default -- pairing forgotten, rebooting into setup");
                        } else {
                            char hdr[sizeof g_server_hdr];
                            server_host_header(&rec, hdr, sizeof hdr);
                            wf_logf(WF_WARN, "server: pairing forgotten, rebooting into setup -- now %s", hdr);
                        }
                        fw_rom_request_reboot(0);
                        con_reboot_pending = true;
                    }
                    break;
                case SC_REBOOT:
                    wf_logf(WF_INFO, "server: rebooting");
                    fw_rom_request_reboot(0);
                    con_reboot_pending = true;
                    break;
                case SC_NONE:
                    break;
                }
            }
        }
#endif

        // Bounded on purpose. Four lines per 1 ms iteration keeps up with a
        // seek across the whole disk, and caps what a host that has stopped
        // reading can cost this loop (PICO_STDIO_USB_STDOUT_TIMEOUT_US in
        // CMakeLists bounds each write).
        wf_log_drain(4);
        sleep_ms(1);
    }
}
