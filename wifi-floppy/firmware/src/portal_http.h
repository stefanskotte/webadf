#ifndef PORTAL_HTTP_H
#define PORTAL_HTTP_H
// Pure HTTP request handler for the provisioning portal's config page: one
// GET route that renders a form, one POST route that decodes it, and a
// catch-all that 302-redirects everything else back to the portal root.
// That catch-all is what makes iOS/Android show a "Sign in to network"
// sheet at all -- see the .c file's header comment. No sockets, no
// pico-sdk/lwIP -- only C standard headers plus config_store.h (for
// device_config_t) and dns_server.h (for PORTAL_IP_*) -- so this links
// into the host test build. Task 6 binds a TCP listener to it.
#include "config_store.h"

typedef enum { PORTAL_ACT_NONE, PORTAL_ACT_SUBMIT } portal_action_t;

typedef struct {
    portal_action_t action;
    device_config_t submitted;   // valid only when action == PORTAL_ACT_SUBMIT
} portal_result_t;

// Render a reply for one request. `err` is shown on the form when non-NULL
// (e.g. "Wrong password" from a previous attempt); NULL shows no error
// block.
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
int portal_request(const char *method, const char *path, const char *body,
                   const char *mac_str, const char *err,
                   char *out, int cap, portal_result_t *res);

#endif
