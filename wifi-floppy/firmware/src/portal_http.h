#ifndef PORTAL_HTTP_H
#define PORTAL_HTTP_H
// Pure HTTP request handler for the provisioning portal's config page: one
// GET route that renders a form, one POST route that decodes it, and a
// catch-all that 302-redirects everything else back to the portal root.
// That catch-all is what makes iOS/Android show a "Sign in to network"
// sheet at all -- see the .c file's header comment. No sockets, no
// pico-sdk/lwIP -- only C standard headers plus config_store.h (for
// setup_form_t) and dns_server.h (for PORTAL_IP_*) -- so this links
// into the host test build. Task 6 binds a TCP listener to it.
#include "config_store.h"
#include "provisioning.h"   // net_join_t, prov_forget_t: pure headers

#include <stdbool.h>

typedef enum {
    PORTAL_ACT_NONE,
    PORTAL_ACT_SUBMIT,   // POST /save: a network to join (and maybe a code)
    PORTAL_ACT_FORGET,   // POST /forget: a saved network to remove
    PORTAL_ACT_DONE,     // POST /done: close the setup page (opened on request only)
} portal_action_t;

typedef struct {
    portal_action_t action;
    setup_form_t    submitted;   // valid only when action == PORTAL_ACT_SUBMIT
    char            forget[CONFIG_SSID_MAX + 1];   // valid only when action == PORTAL_ACT_FORGET
} portal_result_t;

// What the page knows about the board besides `err` (several networks, field
// report 2026-11-14). Names only -- a password never reaches this file except
// in a request body, and is never rendered. NULL renders as a fresh board: no
// saved networks, a pairing code required, nothing prefilled.
//
// The error, too, is data here rather than text (review I3: an 800 B message
// buffer and a 192 B remove-reason buffer were static RAM the heap could not
// spare). The page words it as it renders, from these few bytes; the words
// are portal_http.c's, and portal_error_text() gives them as plain text.
typedef enum {
    PORTAL_ERR_NONE,
    PORTAL_ERR_JOIN,     // the submitted network (prefill) failed with `join`
    PORTAL_ERR_ROUND,    // every saved network failed: result[] in order[]
    PORTAL_ERR_SAVE,     // the submitted network (prefill) joined but was not saved
    PORTAL_ERR_FORGET,   // removing forget_ssid was refused: `forget`
    PORTAL_NOTE_SAVED,   // not an error: notice_ssid was checked and saved (opened on request)
    PORTAL_ERR_HELD,     // opened on request: prefill's Save was accepted, then held (`hold` says why)
} portal_err_t;

typedef enum {
    PORTAL_HOLD_NONE = 0,
    PORTAL_HOLD_DISK,       // a disk in DF0 or DF1
    PORTAL_HOLD_WRITES,     // Amiga saves not yet uploaded
    PORTAL_HOLD_NETWORK,    // DF1 Network (PaulaNET) is on
} portal_hold_t;

typedef struct {
    int  n;                                            // saved networks, 0..CONFIG_NETS_MAX
    char ssid[CONFIG_NETS_MAX][CONFIG_SSID_MAX + 1];   // in saved order
    int  last;                                         // index of the last joined, -1 for none
    bool have_code;        // paired (prov_paired): the code field may be left empty
    char prefill[CONFIG_SSID_MAX + 1];   // the network-name field's initial value
    portal_err_t  err;
    net_join_t    join;                       // PORTAL_ERR_JOIN
    net_join_t    result[CONFIG_NETS_MAX];    // PORTAL_ERR_ROUND, per ssid[] index
    unsigned char order[CONFIG_NETS_MAX];     // PORTAL_ERR_ROUND: ssid[] indices, in the order tried
    bool          disk_mounted;               // PORTAL_ERR_SAVE: the reason it was not saved
    prov_forget_t forget;                     // PORTAL_ERR_FORGET
    char          forget_ssid[CONFIG_SSID_MAX + 1];
    // A Remove is being written (portal_net.c): a second one is answered with
    // "try again" rather than accepted and silently dropped (review M3).
    bool          forget_busy;
    // Opened from the web app while the board stays online (2026-11-15,
    // wifi_ctl.h). The page then: says which network the board is on (ssid[last])
    // and that it stays online; takes no pairing code (a submitted one is
    // dropped -- the board is paired, and a code there would re-pair it); offers
    // no Remove for the network in use; says Save checks the network first; and
    // has a Done button (POST /done). left_min: minutes until it closes by itself.
    bool          on_request;
    unsigned      left_min;
    // Opened on request: why Save cannot check a network right now (portal_hold_t; review of 3bf330b2, I3).
    // Checking leaves the board's network for up to a minute, so: not with a disk in DF0 or DF1, not while the
    // Amiga's saves wait to be uploaded, not while the Amiga's own network (DF1 Network) runs through the board.
    // The page says why and refuses Save before anything is joined; main.c checks again before it leaves.
    unsigned char hold;
    char          notice_ssid[CONFIG_SSID_MAX + 1];   // PORTAL_NOTE_SAVED
} portal_view_t;

// The error the page would show for (err, view), as plain text: '\n' between
// lines, SSIDs unescaped. `err` (a fixed string, e.g. a rejected pairing
// code) wins over view->err when both are set. Returns the length, 0 for no
// error, or -1 if it would not fit `cap` (then buf holds ""). For tests and
// logs; the page renders the same words, escaped.
int portal_error_text(const char *err, const portal_view_t *view, char *buf, int cap);
// The words for one failed join of `ssid`, the same way.
int portal_join_message(char *buf, int cap, const char *ssid, net_join_t r);


// Render a reply for one request. `err` is shown on the form when non-NULL
// (a fixed string, e.g. "Invalid or already-used pairing code"); otherwise
// view->err is worded (portal_error_text). Both are plain text -- escaped
// here, '\n' becomes a line break -- since the words carry SSIDs, which are
// attacker-shaped.
//
// A POST /save that decodes completely does NOT come back as the form: it
// renders a distinct "Credentials accepted / connecting" confirmation
// body, and `err` -- which describes the attempt before this one -- is
// deliberately dropped rather than carried into it. (Final-review
// Important 1: the old behaviour re-rendered the form with the stale
// banner still set, so a corrected password looked exactly like another
// failure at the moment the board was actually accepting it.) The two
// bodies are guaranteed distinguishable -- the confirmation page carries
// no <form> at all -- and both are host-tested to be so.
//
// `body` is the request body for POST (may be NULL for GET, and is
// treated as empty if so). `mac_str` is shown on the page so whoever is
// holding the phone knows which board they are configuring; NULL is
// rendered as an empty string. The password field is marked required in
// the rendered form because both association sites hardcode
// CYW43_AUTH_WPA2_AES_PSK: an open network cannot work, and the page says
// so rather than letting it fail later as a generic "Could not connect".
// That is a page-level rule, not a parse rule -- this function still
// accepts an empty `pass` value from a hand-built POST, which then fails
// at association like any other wrong credential. `res` is always written:
// action is
// PORTAL_ACT_NONE unless this request was a POST /save whose body decoded
// to all three fields, within their length limits -- an over-length field
// is rejected outright, never truncated (a silently truncated SSID would
// provision the wrong network), and a submitted password is never echoed
// back into the rendered page.
//
// Returns bytes written to `out`, or 0 if the reply would not fit in `cap`.
// Never writes past `cap`. Pure: no sockets.
//
// Several networks: the form lists `view`'s saved networks, each with a
// Remove button (POST /forget, PORTAL_ACT_FORGET -- except the only one,
// which cannot be removed), and adds one per submit. A submit is refused on
// the page, before anything is joined, when it could not be stored: no
// pairing code and none stored, or a new SSID with CONFIG_NETS_MAX already
// saved (the rule is "refuse and say so", never drop one silently). The
// pairing code is optional once one is stored; empty keeps the pairing.
int portal_request(const char *method, const char *path, const char *body,
                   const char *mac_str, const char *err, const portal_view_t *view,
                   char *out, int cap, portal_result_t *res);

// The same reply, one window of it: bytes [skip, skip + cap - 1) of the page
// land in `out` (NUL-terminated), the return value is how many, and *total
// is the whole page's length. Pages with several networks and a named
// failure run 2.4-6 KB; portal_net.c keeps a 2 KB buffer per connection
// (there is no SRAM for more -- the heap sits near its floor) and sends a
// longer page by rendering it again for each next window. That works because
// rendering is pure: the same inputs give the same page, byte for byte.
// `res` is written exactly as portal_request() writes it, every call.
int portal_request_window(const char *method, const char *path, const char *body,
                          const char *mac_str, const char *err, const portal_view_t *view,
                          int skip, char *out, int cap, portal_result_t *res, int *total);

// HTML-escapes `in` (NULL reads as "") into `out` (`cap` bytes including
// the NUL): & < > " ' become entities, control bytes become '?', bytes
// >= 0x80 pass through unchanged (UTF-8 SSIDs read as themselves). Returns
// the escaped length, or -1 if it would not fit -- refused, never
// truncated, the same contract as the form fields. Pure; host-tested.
int portal_html_escape(const char *in, char *out, int cap);

#endif
