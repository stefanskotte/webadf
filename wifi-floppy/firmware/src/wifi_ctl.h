#ifndef WIFI_CTL_H
#define WIFI_CTL_H
// Wi-Fi networks from the web app (operator ruling 2026-11-15): the Devices
// page's Board settings lists the board's saved networks, removes one, and
// asks the board to open its setup page while it stays online, so a network
// (a phone hotspot, say) can be added at home before it is needed.
//
// The wire, both directions (HANDOFF "Wi-Fi networks from the web app"):
//
//   server -> board: a CURSOR. The poll body carries "wifi":{"v":N} to a board
//     that sends &wifiAck=; the poll wakes while N != wifiAck. A board that sees
//     v != its ack fetches GET /api/device/wifi:
//       {"seq":N,"op":"open"|"close"|"remove"|"none","ssid":"<hex>"}
//     ssid only with remove: the name's octets in hex (an SSID is up to 32
//     arbitrary octets; hex costs no more than JSON escaping at its worst, and
//     names it exactly). A re-request, a retry or a withdrawal is the next
//     seq: "none" is a withdrawal, and also what the server sends for an open
//     that waited past its two minutes, or a seq the board already reported.
//     The board handles every seq once, whatever its op, and acks it.
//
//   board -> server: the status report's "wifi" tail (wifi_report_json),
//     sent whenever it changed since the server last heard it -- and, like
//     lastBoot, left out (still owed) on the rare report too full for it:
//       ,"wifi":{"nets":["<hex>",...],"cur":i,"ack":N,"res":"ok","setup":S}
//     nets: the saved names (never a password), in saved order; cur: the index
//     the board is on now, -1 for none; ack: the last seq handled; res: what
//     that seq came to (wifi_res_wire); setup: seconds the setup page stays
//     open, 0 when it is closed.
//
// Pure C, no SDK include: test/test_wifi_ctl.c.
#include <stdbool.h>
#include <stdint.h>
#include "config_store.h"
#include "provisioning.h"   // prov_forget_t, prov_add_t, net_join_t: pure headers

// How long the setup page stays open on request. A re-request (a new "open")
// starts the ten minutes again; Done on the page or Close in the web app ends
// it sooner. After a network was checked, at least WIFI_SETUP_AFTER_CHECK_MS
// remain, so the result can be read.
#define WIFI_SETUP_MS             (10u * 60u * 1000u)
#define WIFI_SETUP_AFTER_CHECK_MS (2u * 60u * 1000u)

typedef enum {
    WIFI_OP_NONE = 0,
    WIFI_OP_OPEN,
    WIFI_OP_CLOSE,
    WIFI_OP_REMOVE,
    WIFI_OP_UNKNOWN,   // a newer server's op: acked, nothing done ("unknown")
} wifi_op_t;

typedef struct {
    uint32_t  seq;
    wifi_op_t op;
    char      ssid[CONFIG_SSID_MAX + 1];   // WIFI_OP_REMOVE only
} wifi_cmd_t;

// GET /api/device/wifi's body. False when it is not one (no seq, or a remove
// whose name is not 1..32 octets of hex): nothing is acked, the board asks
// again on the next poll.
bool wifi_cmd_parse(const char *json, wifi_cmd_t *out);

typedef enum {
    WIFI_RES_NONE = 0,       // nothing handled since boot: "res" is not sent
    WIFI_RES_OK,             // done: opened, closed, removed
    WIFI_RES_IDLE,           // "none": a withdrawal, or an open the server let lapse
    WIFI_RES_UNKNOWN,        // an op this firmware does not know
    WIFI_RES_DISK,           // a disk is in the drive: no settings written, no network change
    WIFI_RES_ONLY_ONE,       // remove: the only saved network
    WIFI_RES_IN_USE,         // remove: the network the board is on now
    WIFI_RES_NOT_SAVED,      // remove: no such network (already gone)
    WIFI_RES_WRITE_FAILED,   // the flash write failed
    WIFI_RES_SUBNET,         // open: the board's own network uses the setup network's addresses (192.168.4.x)
} wifi_res_t;

const char *wifi_res_wire(wifi_res_t r);   // "" for WIFI_RES_NONE
wifi_res_t  wifi_res_from_forget(prov_forget_t f);

// Whether an open may go ahead. A disk in the drive refuses it: adding a
// network writes flash (config_store's guard) and checking one leaves the
// current network for up to a minute. A home network on 192.168.4.0/24 would
// route into the setup network's own subnet while both are up.
wifi_res_t wifi_open_check(bool disk_mounted, bool subnet_clash);

// Hex both ways. encode: 2 chars a byte, NUL-terminated; -1 when it would not
// fit. decode: lowercase or uppercase pairs, 1..cap-1 bytes and no NUL byte
// inside; false otherwise (out is then "").
int  wifi_hex_encode(const char *s, char *out, int cap);
bool wifi_hex_decode(const char *hex, char *out, int cap);

// The status tail, from `cfg`'s names. -1 (and *buf = '\0') when it does not
// fit `cap` -- the report goes without it and it stays owed.
typedef struct {
    const device_config_t *cfg;   // NULL or no networks: "nets":[]
    int        cur;               // -1: on none of them
    uint32_t   ack;
    wifi_res_t res;
    uint32_t   setup_s;
} wifi_report_t;
int wifi_report_json(const wifi_report_t *r, char *buf, int cap);
// The longest tail: four 32-octet names (64 hex digits each) and every
// number at its widest. test_wifi_ctl.c checks the real worst against it.
#define WIFI_REPORT_MAX 345

// The open window, on the board's ms clock (wrap-safe).
typedef struct {
    bool     open;
    uint32_t until_ms;
} wifi_window_t;
void     wifi_window_open(wifi_window_t *w, uint32_t now, uint32_t ms);       // (re)starts it
void     wifi_window_at_least(wifi_window_t *w, uint32_t now, uint32_t ms);   // open: never less than ms left
void     wifi_window_close(wifi_window_t *w);
uint32_t wifi_window_left_ms(const wifi_window_t *w, uint32_t now);           // 0 when closed or past
bool     wifi_window_due(const wifi_window_t *w, uint32_t now);               // open, and the time is up
unsigned wifi_window_left_min(const wifi_window_t *w, uint32_t now);          // rounded up; 0 when closed

// Adding a network while online: check it by joining it, save it, go back.
// The board's station can be on one network at a time, so checking leaves
// the current one; the sequence always ends on a network, or says it did not:
//   1. join the new network (`join`, one attempt);
//   2. joined: save it (prov_add_network) -- not on failure, nothing changes;
//   3. go back: rounds over the saved networks, the one the board was on
//      first, up to PROV_MAX_ASSOC_FAILURES rounds (`p`'s own round logic).
// `join` is net_radio_sta_connect in main.c, a fake in the tests; `ctx` is
// passed through. On return p->first/joined name the network the board is
// on (back_on >= 0), and p->state is PROV_RUNNING whatever happened.
typedef struct {
    net_join_t (*join)(void *ctx, const char *ssid, const char *pass);
    void        *ctx;
} wifi_check_ops_t;

typedef struct {
    net_join_t join;      // the new network's attempt
    bool       tried_save;
    prov_add_t saved;     // valid when tried_save
    int        back_on;   // index of the network the board ended on, -1: none (every round failed)
    int        attempts;  // joins made going back
} wifi_check_t;

void wifi_check_run(provisioning_t *p, const char *ssid, const char *pass,
                    const wifi_check_ops_t *ops, wifi_check_t *out);
// Step 3 alone: up to PROV_MAX_ASSOC_FAILURES rounds over the saved networks,
// `from` first. The index joined, or -1. `attempts` (may be NULL) counts joins.
int wifi_rejoin_run(provisioning_t *p, int from, const wifi_check_ops_t *ops, int *attempts);

#endif
