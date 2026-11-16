#ifndef WIFI_FALLBACK_H
#define WIFI_FALLBACK_H
// Moving to another saved network while running (bench 2026-11-16, HANDOFF "Phone/hotspot bench"). The board walks
// its saved networks only at start-up; in the poll loop it stayed on the network it had joined:
//   A. that network went away (an iPhone hotspot switched off): link DOWN for minutes, the driver re-trying the same
//      name, while another saved network was in range;
//   B. the link stayed up but nothing got through (UniFi "Block" of the board): TLS and DNS failures forever.
//
// The decisions live here (pure C, test/test_wifi_fallback.c); main.c's wifi_fallback_step does the radio work:
// a scan for the saved names (net_radio_scan_names) and then the start-up's own rounds (wifi_rejoin_run), with the
// same leave/drop hygiene as the Save check (net_join.c drops what the station holds before every attempt).
//
// The rules:
//   * One saved network: nothing new. A stays as it was (the driver keeps re-trying the network, and a short drop
//     recovers on its own -- fw 1.21.1), B has nowhere to go: a leave and re-join of the same network cannot undo
//     a block or a server outage, and every leave risks the router refusing the same MAC for minutes (bench 2).
//   * A, link down for WFB_LINK_GRACE_MS (a blip on the same network recovers inside it, as today): scan. Another
//     saved network in range -> rounds starting with the CURRENT one (it may have come back this second, and an
//     explicit leave + join also clears a stuck association), then the others in saved order. Nothing else in
//     range -> stay and let the driver keep trying; scan again after 1, 2, 4, then every 5 minutes. A scan that
//     could not run counts as an empty one the first time (review M2: an idle board must not restart through a
//     router's reboot because of one failed scan); the second failure in a row runs the rounds anyway.
//   * B, link up and no answer from the server for WFB_DEAD_MS (2 min, operator ruling 2026-11-16: 5 min was a
//     poor experience) AND at least WFB_DEAD_FAILS requests with no answer since (the worst single request is
//     ~105 s, so one slow request alone can never make it; a normal pass answers every ~25 s): scan. Another saved network in range -> rounds starting with THAT one (the
//     first in saved order); the current one is still in the round, so a fruitless move ends back where it was.
//     The flapping guard: B never moves without another saved network in range (a server outage on a single home
//     network leaves the board alone), and the dead period doubles after every move or empty scan that did not
//     bring an answer (2, 4, 8, 15 min at most), reset by the first answer. A server outage with a hotspot in
//     range therefore costs at most a few moves an hour, each ~15-30 s off line. Never while DF1 is Network
//     (review I2, `hold_dead`): the Amiga's own traffic may be fine while only the web server is down, and a move
//     changes the board's address under it. A link down may still move (nothing gets through anyway).
//   * BETTER (review I3, coordinator ruling 2026-11-16): on a saved network other than the first (index > 0), the
//     board IDLE (`idle`: no disk in DF0/DF1, no saves waiting, DF1 not Network) and nothing held: every
//     WFB_BETTER_MS it scans, and a saved network earlier in the list in range -> rounds from it (the current one
//     still in them, so a failed return ends where it was). Without this a move for a server outage left the board
//     on a hotspot for good. The period doubles after each return (10, 20, 40, 60 min at most) and is reset by an
//     answer on the first network -- a long server outage cannot bounce the board between home and hotspot faster.
//     Third review: the reset needs home up and answering for a whole period (a marginal home network that answers
//     once and drops keeps the longer period); a return that did not reach the earlier network (a stale password)
//     counts as an empty scan; a return never leads to a restart (if its rounds end on nothing, the board keeps
//     trying every WFB_LOST_RETRY_MS); and no return while the board is on the network chosen on the power-on
//     setup page (`page_idx`) -- the person standing there picked it. Review of bb89103e: only while on it; a move
//     the fallback makes clears the choice (wfb_page_after_run), so the way home is open again after it.
//   * Held (no action; the clocks keep running): the setup page opened on request (its window), an OTA trial
//     before its deadline (it reverts on its own if the network is dead), an update's reboot owed. The Save check
//     runs its own rounds and resets this (wfb_reset).
//   * A run that found no network leaves the station holding nothing, so nobody else would try again: an idle
//     board restarts into its normal start (main.c, the Save check's rule: never with a disk in a drive, saves
//     waiting or DF1 Network on); otherwise the rounds run again every WFB_LOST_RETRY_MS, from the network it was
//     on last (provisioning's `first`, review M1), with no scan.
#include <stdbool.h>
#include <stdint.h>

#define WFB_LINK_GRACE_MS  30000u
#define WFB_RESCAN_MS      60000u
#define WFB_RESCAN_MAX_MS  300000u
#define WFB_DEAD_MS        120000u
#define WFB_DEAD_MAX_MS    900000u
#define WFB_DEAD_FAILS     2u
#define WFB_LOST_RETRY_MS  30000u
#define WFB_BETTER_MS      600000u
#define WFB_BETTER_MAX_MS  3600000u

typedef enum {
    WFB_DUE_NONE = 0,
    WFB_DUE_DOWN,    // A: scan, then maybe rounds from the current network
    WFB_DUE_DEAD,    // B: scan, then maybe rounds from another network in range
    WFB_DUE_LOST,    // the last run found nothing: rounds again, no scan
    WFB_DUE_BETTER,  // on a later saved network, idle: scan, then maybe rounds from an earlier one
} wfb_due_t;

typedef struct {
    bool     started;
    uint32_t answers;       // the client's answer count last seen (device_client_t.answers)
    bool     down;          // the link is down ...
    uint32_t down_since;    // ... since then
    uint32_t quiet_since;   // the link up, and no answer since then
    uint32_t dead_ms;       // B's period now (doubles, reset by an answer)
    uint32_t rescan_at;     // A: no scan before this
    uint32_t rescan_ms;     // A's next wait after an empty scan
    bool     lost;          // the last run joined nothing
    uint32_t lost_at;       // the next run's time
    int      scan_fails;    // A: scans in a row that could not run
    uint32_t better_since;  // BETTER: the period runs from here (reset when the network changes)
    uint32_t better_ms;     // BETTER's period now (doubles after a return, reset by an answer on network 0)
    int      better_cur;    // the network `better_since` was set for
    int      better_from;   // the network the last BETTER pick aimed at
    uint32_t home_since;    // network 0 up without a break since then (better_ms resets after a period of it)
    bool     no_restart;    // the lost episode began with a return: no restart (wfb_may_restart)
    uint32_t fails_seen;    // the client's no-answer count last seen (device_client_t.unanswered)
    uint32_t fails_base;    // ... when B's count of failed requests last started (an answer, the link up, a look)
    uint32_t fails_answer;  // ... at the last answer: more since -> the panel's no-server mark
    bool     unheard;       // the link went down since the last answer (the mark stays until one)
} wifi_fb_t;

typedef struct {
    uint32_t now;
    bool     link_up;       // net_radio_sta_up()
    uint32_t answers;       // device_client_t.answers
    int      n_nets;        // saved networks
    bool     hold;          // the setup page on request, an OTA trial, an update reboot owed
    bool     hold_dead;     // DF1 Network: no move for B (the link-up case)
    bool     idle;          // no disk in DF0/DF1, no saves waiting, DF1 not Network: BETTER may run
    int      cur;           // the network the board is on, -1 none
    int      page_idx;      // the network chosen on the power-on setup page, -1 none: no BETTER while on it
    uint32_t fails;         // device_client_t.unanswered
} wfb_in_t;

// The clocks start now (also after the Save check's own rounds, and after any run here).
void wfb_reset(wifi_fb_t *fb, uint32_t now, uint32_t answers);

// Once per poll-loop pass: what is due. Updates the clocks from `in` first, held or not.
wfb_due_t wfb_due(wifi_fb_t *fb, const wfb_in_t *in);

// After the scan a DOWN or DEAD asked for (`seen`: bit i = saved network i is in range; -1: the scan could not run),
// or for LOST (seen ignored): the network the rounds start from, or -1 to stay (the next look is scheduled).
// `cur`: the network the board is on, -1 if none; for LOST the network it was on last (provisioning's `first`).
int wfb_pick(wifi_fb_t *fb, wfb_due_t due, uint32_t now, int cur, int n_nets, int seen);

// After the rounds: `back_on` is the network joined, -1 none (the caller restarts an idle board, or this makes the
// rounds run again in WFB_LOST_RETRY_MS).
void wfb_ran(wifi_fb_t *fb, wfb_due_t due, uint32_t now, int back_on);
// The panel's honest state (operator ruling 2026-11-16): a request has gone unanswered since the last answer, or
// the link is down. Back to normal on the first answer. Valid after wfb_due.
bool wfb_no_server(const wifi_fb_t *fb);
// After a run that joined nothing: may an idle board restart? Not when the episode began with a return.
bool wfb_may_restart(const wifi_fb_t *fb);
// After a BETTER run: did it reach the network it aimed at?
bool wfb_returned(const wifi_fb_t *fb, int back_on);
// The setup page's choice after a run: a run that joined a network ends it (-1), one that joined nothing keeps it.
int wfb_page_after_run(int page_idx, int back_on);
// What a scan's answer means (bench e92807d8, review of bb89103e): a scan that heard nothing at all, not even the
// network the board is on, is a failed one (-1) while the link is up (DEAD, BETTER); with the link down (DOWN) an
// all-quiet scan is an empty one -- a router rebooting with no neighbours around must not run the rounds early.
int wfb_scan_seen(wfb_due_t due, int seen, int results);

#endif
