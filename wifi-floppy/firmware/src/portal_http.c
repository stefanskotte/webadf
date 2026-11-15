// Pure HTTP request handler for the provisioning portal (see
// portal_http.h). Two real routes -- GET / renders the config form, POST
// /save decodes it -- and everything else 302-redirects to the portal
// root.
//
// That catch-all is the whole feature: iOS probes
// http://captive.apple.com/hotspot-detect.html expecting the literal body
// "Success", and Android probes http://.../generate_204 expecting a bare
// 204. Answer either one *correctly* and the phone concludes the network
// has working internet, and no "Sign in to network" sheet ever appears --
// the portal becomes invisible and the board looks dead. Redirecting
// either probe (dns_server.c has already pointed every hostname at us; the
// probe therefore always lands here) is what makes the sheet appear.
//
// No pico-sdk/lwIP includes here -- only C standard headers plus
// config_store.h (setup_form_t) and dns_server.h (PORTAL_IP_*) -- so
// this links into the host test build unmodified. Task 6 binds a TCP
// listener to it.
#include "portal_http.h"
#include "dns_server.h"
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

static int hex_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Decode an application/x-www-form-urlencoded value `in[0..len)` (not
// NUL-terminated -- it is a slice of the request body) into `out`, a
// buffer of size `outcap` bytes including room for the terminating NUL.
// '+' decodes to space, "%XX" decodes to one byte. Returns the decoded
// length, or -1 if:
//   - the decoded value would not fit in outcap - 1 bytes (rejected, never
//     truncated: a silently truncated SSID would provision the wrong
//     network and the failure would surface much later, somewhere else), or
//   - a '%' is not followed by two hex digits, including a '%' whose
//     escape runs past the end of `in` -- every index used to read a hex
//     digit is bounds-checked against `len` before that byte is
//     dereferenced, so a truncated escape at the very end of the buffer
//     is rejected, not read past.
// Never writes past `out + outcap`.
static int urldecode(const char *in, int len, char *out, int outcap) {
    int o = 0;
    for (int i = 0; i < len; i++) {
        char c = in[i];
        unsigned char b;
        if (c == '+') {
            b = ' ';
        } else if (c == '%') {
            // Need in[i+1] and in[i+2] both to exist: i+2 must be a valid
            // index, i.e. i+2 <= len-1, i.e. i+2 < len is false only when
            // the escape is complete. Checked before either is read.
            if (i + 2 >= len) return -1;   // truncated escape
            int hi = hex_val(in[i + 1]);
            int lo = hex_val(in[i + 2]);
            if (hi < 0 || lo < 0) return -1;   // not hex digits
            b = (unsigned char)((hi << 4) | lo);
            i += 2;
        } else {
            b = (unsigned char)c;
        }
        if (o >= outcap - 1) return -1;    // would not fit -- reject, don't truncate
        out[o++] = (char)b;
    }
    out[o] = '\0';
    return o;
}

// Parses `body` (may be NULL, treated as empty) as
// application/x-www-form-urlencoded and fills `f`'s ssid/pass/code from
// the "ssid"/"pass"/"code" fields. A field that appears more than once
// resolves to its last occurrence -- cleanly, not a mix of both -- so the
// struct is never left half-populated from two different attempts. Any
// unknown field is ignored (forward compatible with a future field this
// board does not understand yet). Returns true only if ssid and pass were
// seen and every value decoded within its length limit; "code" may be
// missing or empty (several networks: empty keeps the stored pairing, and
// portal_request decides whether that is allowed). On false, `f` must not
// be relied on by the caller (portal_http.h's contract: `submitted` is valid
// only when the request is a submit).
static bool parse_form(const char *body, setup_form_t *f) {
    memset(f, 0, sizeof *f);
    bool have_ssid = false, have_pass = false;

    if (!body) return false;
    int len = (int)strlen(body);
    int i = 0;
    while (i < len) {
        int pair_start = i;
        while (i < len && body[i] != '&') i++;
        int pair_end = i;
        if (i < len) i++;   // skip '&' for the next iteration

        int eq = -1;
        for (int j = pair_start; j < pair_end; j++) {
            if (body[j] == '=') { eq = j; break; }
        }
        if (eq < 0) continue;   // no '=' in this pair -- nothing to key on

        const char *key = body + pair_start;
        int keylen = eq - pair_start;
        const char *val = body + eq + 1;
        int vallen = pair_end - (eq + 1);

        if (keylen == 4 && memcmp(key, "ssid", 4) == 0) {
            if (urldecode(val, vallen, f->ssid, (int)sizeof f->ssid) < 0) return false;
            have_ssid = true;
        } else if (keylen == 4 && memcmp(key, "pass", 4) == 0) {
            if (urldecode(val, vallen, f->pass, (int)sizeof f->pass) < 0) return false;
            have_pass = true;
        } else if (keylen == 4 && memcmp(key, "code", 4) == 0) {
            if (urldecode(val, vallen, f->code, (int)sizeof f->code) < 0) return false;
        }
        // any other field name: ignored
    }
    return have_ssid && have_pass;
}

// ---------------------------------------------------------------- rendering
//
// Pages are appended straight into `out`. No intermediate buffers: this runs
// in an lwIP callback, on core1's IRQ stack (main.c's CORE1_STACK_BYTES
// comment), and the page now carries up to four escaped SSIDs and an error
// that names them -- copies of those on the stack would be kilobytes.
//
// And the page may be longer than `out`: the form with several networks and
// a named failure runs 2.4-6 KB, while portal_net.c gives each connection a
// 2 KB buffer (and SRAM has no 12 KB to spare: the heap's low-water already
// sits near its 20 KB floor, HANDOFF). So the appender renders a WINDOW: it
// walks the whole page, counting every byte in `pos`, and keeps only bytes
// [skip, skip + cap - 1). Rendering is pure, so the same request rendered
// again with the next `skip` yields the next slice of the same page --
// portal_net.c sends a page that way, one window at a time.
typedef struct {
    char *out;
    int   cap;     // out's size; at most cap - 1 bytes land, then a NUL
    int   skip;    // page offset of out[0]
    int   pos;     // page bytes rendered so far, kept or not
    int   len;     // bytes in out
    bool  plain;   // portal_error_text(): text as is, no escaping, '\n' kept
} sb_t;

static void sb_put(sb_t *b, const char *s, int n) {
    int from = b->pos, to = b->pos + n;   // this piece is page[from, to)
    b->pos = to;
    int lo = from > b->skip ? from : b->skip;
    int hi = b->skip + b->cap - 1;
    if (to < hi) hi = to;
    if (hi <= lo) return;                 // outside the window
    memcpy(b->out + (lo - b->skip), s + (lo - from), (size_t)(hi - lo));
    if (hi - b->skip > b->len) b->len = hi - b->skip;
    b->out[b->len] = '\0';
}

static void sb_raw(sb_t *b, const char *s) {
    sb_put(b, s, (int)strlen(s));
}

// Only ever short pieces (a redirect, a count): formatted into a small local.
static void sb_fmt(sb_t *b, const char *fmt, ...) {
    char tmp[160];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if (n >= (int)sizeof tmp) n = (int)sizeof tmp - 1;   // never: every caller's text is short
    sb_put(b, tmp, n);
}

// The one escaping rule, shared by portal_html_escape() and the appender:
// & < > " ' become entities, control bytes become '?', bytes >= 0x80 pass
// through unchanged (UTF-8 SSIDs read as themselves). `one` is scratch for
// the pass-through case.
static const char *escape_one(unsigned char c, char one[2]) {
    switch (c) {
    case '&':  return "&amp;";
    case '<':  return "&lt;";
    case '>':  return "&gt;";
    case '"':  return "&quot;";
    case '\'': return "&#39;";
    default:
        // Control bytes (an SSID may hold any octet) render as '?'
        // rather than as raw bytes in the page. Bytes >= 0x80 pass
        // through: a UTF-8 SSID should read as itself.
        one[0] = (c < 0x20 || c == 0x7f) ? '?' : (char)c;
        one[1] = '\0';
        return one;
    }
}

// Escaped text; with `br`, each '\n' becomes <br> (the error block's lines).
// In a plain sink (portal_error_text) the text goes in as it is.
static void sb_html(sb_t *b, const char *text, bool br) {
    if (b->plain) { sb_raw(b, text ? text : ""); return; }
    for (const char *p = text ? text : ""; *p; p++) {
        char one[2];
        sb_raw(b, (br && *p == '\n') ? "<br>" : escape_one((unsigned char)*p, one));
    }
}

int portal_html_escape(const char *in, char *out, int cap) {
    if (!out || cap <= 0) return -1;
    int o = 0;
    for (const char *p = in ? in : ""; *p; p++) {
        char one[2];
        const char *rep = escape_one((unsigned char)*p, one);
        int n = (int)strlen(rep);
        if (o + n > cap - 1) return -1;   // would not fit -- refuse, never truncate
        memcpy(out + o, rep, (size_t)n);
        o += n;
    }
    out[o] = '\0';
    return o;
}

// ---------------------------------------------------------------- the error's words
//
// Moved here from provisioning.c (review I3): the page words the error from
// the view's few bytes as it renders, so no message buffer has to be kept.
// Only distinctions net_radio_sta_connect can actually make (net_join.c).
// Spec §6's two-message requirement is "wrong password" vs "not found"; both
// stay, with the network named.

// Curly quotes around an SSID: a straight " would become &quot; in the page,
// and the SSID itself may hold one.
#define LQ "\xe2\x80\x9c"
#define RQ "\xe2\x80\x9d"

static const char *reason_short(net_join_t r) {
    switch (r) {
    case NET_JOIN_NOT_FOUND:  return "not found";
    case NET_JOIN_BAD_AUTH:   return "wrong password";
    case NET_JOIN_FAILED:     return "the network refused the connection";
    case NET_JOIN_NO_ADDRESS: return "joined, but the network gave the board no address";
    case NET_JOIN_TIMEOUT:    return "no answer in time";
    case NET_JOIN_ERROR:      return "the board's WiFi chip did not start the join";
    case NET_JOIN_OK:         break;
    }
    return "could not connect";
}

static const char *reason_hint(net_join_t r) {
    switch (r) {
    case NET_JOIN_NOT_FOUND:
        return "The board only sees 2.4 GHz networks, and cannot join one that is WPA3-only. "
               "Phone hotspots often need " LQ "Maximise compatibility" RQ " (iPhone) or a "
               "2.4 GHz band (Android) turned on.";
    case NET_JOIN_BAD_AUTH:
        return "Check the password; it is case-sensitive. If it is right, the network may be "
               "WPA3-only: the board needs WPA2.";
    case NET_JOIN_FAILED:
        return "A network that refuses the board may be WPA3-only (the board needs WPA2) or "
               "admit only devices it knows.";
    case NET_JOIN_NO_ADDRESS:
        return "Restart the router or hotspot, then try again.";
    case NET_JOIN_TIMEOUT:
        // Review M4: a wrong WPA2 password often ends here, not as "wrong
        // password" -- the driver takes a missing key message for the edge of
        // the cell and rejoins until the time runs out (net_radio_cyw43.c).
        return "A wrong password often looks like this: check it (it is case-sensitive). "
               "Otherwise move the board closer to the router, then try again.";
    case NET_JOIN_ERROR:
    case NET_JOIN_OK:
        break;
    }
    return "Try again.";
}

// The words for "a disk is in the drive": config_store's write guard is
// psram_active_slot() != SLOT_NONE -- a disk image is mounted (being served),
// and a flash write would park core0, which serves it. In the setup page the
// board cannot reach the web app to eject, but a power cycle starts with the
// drive empty (a startup disk is the server's to put back, once online).
#define DISK_WHY "a disk is in the drive, and the board does not write its settings while " \
                 "one is. Switch the board off and on, which empties the drive, then try again."

static void sb_txt(sb_t *b, const char *s);
static void sb_user(sb_t *b, const char *s);

static void msg_join(sb_t *b, const char *ssid, net_join_t r) {
    sb_txt(b, "Could not join " LQ);
    sb_user(b, ssid);
    sb_txt(b, RQ ": ");
    sb_txt(b, reason_short(r));
    sb_txt(b, ".\n");
    sb_txt(b, reason_hint(r));
}

static void msg_round(sb_t *b, const portal_view_t *v) {
    int n = v->n < 0 ? 0 : (v->n > CONFIG_NETS_MAX ? CONFIG_NETS_MAX : v->n);
    if (n == 1) { msg_join(b, v->ssid[0], v->result[0]); return; }
    sb_txt(b, "Could not join any saved network:");
    for (int k = 0; k < n; k++) {   // in the order tried, so the list reads as what happened
        int i = v->order[k] < n ? v->order[k] : 0;
        sb_txt(b, "\n" LQ);
        sb_user(b, v->ssid[i]);
        sb_txt(b, RQ ": ");
        sb_txt(b, reason_short(v->result[i]));
        sb_txt(b, ".");
    }
    // Each kind of advice once, in a fixed order.
    static const net_join_t kinds[] = { NET_JOIN_NOT_FOUND, NET_JOIN_BAD_AUTH, NET_JOIN_FAILED,
                                        NET_JOIN_NO_ADDRESS, NET_JOIN_TIMEOUT, NET_JOIN_ERROR,
                                        NET_JOIN_OK };
    for (unsigned k = 0; k < sizeof kinds / sizeof kinds[0]; k++) {
        bool seen = false;
        for (int i = 0; i < n; i++) seen = seen || v->result[i] == kinds[k];
        if (seen) { sb_txt(b, "\n"); sb_txt(b, reason_hint(kinds[k])); }
    }
}

static void msg_forget(sb_t *b, const portal_view_t *v) {
    switch (v->forget) {
    case PROV_FORGET_NOT_SAVED:
        sb_txt(b, LQ); sb_user(b, v->forget_ssid); sb_txt(b, RQ " is not saved on this board.");
        return;
    case PROV_FORGET_ONLY_ONE:
        sb_txt(b, LQ); sb_user(b, v->forget_ssid);
        sb_txt(b, RQ " is the only saved network. Add another network before removing it.");
        return;
    case PROV_FORGET_DISK_MOUNTED:   // review M6: say why
        sb_txt(b, "Could not remove " LQ); sb_user(b, v->forget_ssid); sb_txt(b, RQ ": " DISK_WHY);
        return;
    case PROV_FORGET_WRITE_FAILED:
    case PROV_FORGOT:
        break;
    }
    sb_txt(b, "Could not remove " LQ); sb_user(b, v->forget_ssid);
    sb_txt(b, RQ ": the change was not saved. Try again.");
}

static void msg_save(sb_t *b, const portal_view_t *v) {
    sb_txt(b, "Joined " LQ); sb_user(b, v->prefill);
    sb_txt(b, v->disk_mounted ? RQ " but could not save it: " DISK_WHY
                              : RQ " but could not save it. Try again.");
}

static bool has_error(const char *err, const portal_view_t *v) {
    return (err && *err) || (v && v->err != PORTAL_ERR_NONE);
}

static void err_words(sb_t *b, const char *err, const portal_view_t *v) {
    if (err && *err) { sb_txt(b, err); return; }
    if (!v) return;
    switch (v->err) {
    case PORTAL_ERR_JOIN:   msg_join(b, v->prefill, v->join); break;
    case PORTAL_ERR_ROUND:  msg_round(b, v); break;
    case PORTAL_ERR_SAVE:   msg_save(b, v); break;
    case PORTAL_ERR_FORGET: msg_forget(b, v); break;
    case PORTAL_ERR_NONE:   break;
    }
}

int portal_error_text(const char *err, const portal_view_t *view, char *buf, int cap) {
    if (!buf || cap <= 0) return -1;
    buf[0] = '\0';
    sb_t b = { buf, cap, 0, 0, 0, true };
    err_words(&b, err, view);
    if (b.pos != b.len) { buf[0] = '\0'; return -1; }   // refused, never truncated
    return b.len;
}

int portal_join_message(char *buf, int cap, const char *ssid, net_join_t r) {
    if (!buf || cap <= 0) return -1;
    buf[0] = '\0';
    sb_t b = { buf, cap, 0, 0, 0, true };
    msg_join(&b, ssid, r);
    if (b.pos != b.len) { buf[0] = '\0'; return -1; }
    return b.len;
}

// Developer text (may hold '\n': a line break) and user text (an SSID).
static void sb_txt(sb_t *b, const char *s)  { sb_html(b, s, true); }
static void sb_user(sb_t *b, const char *s) { sb_html(b, s, false); }

// The head every page shares: inline <style>, no external URLs of any kind
// (the AP has no route to the internet -- an external reference just hangs).
static void sb_head(sb_t *b) {
    sb_raw(b,
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: text/html; charset=utf-8\r\n"
    "Connection: close\r\n"
    "\r\n"
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    "<title>WiFi Floppy Setup</title>"
    "<style>"
    "body{font-family:sans-serif;max-width:480px;margin:2em auto;padding:0 1em;}"
    "input{width:100%;padding:.5em;margin:.3em 0 1em;box-sizing:border-box;"
    "font-size:1em;}"
    "label{font-weight:bold;display:block;}"
    "button{padding:.6em 1.2em;font-size:1em;}"
    ".err{background:#fee3e3;border:1px solid #c00;padding:.6em 1em;"
    "margin-bottom:1em;color:#900;border-radius:4px;}"
    ".mac{color:#666;font-size:.9em;}"
    ".hint{color:#666;font-size:.85em;margin:-.8em 0 1em;}"
    ".nets{list-style:none;padding:0;margin:0 0 1.5em;}"
    ".nets li{display:flex;align-items:center;justify-content:space-between;"
    "border-bottom:1px solid #ddd;padding:.4em 0;}"
    ".nets form{margin:0;}"
    ".nets button{padding:.3em .8em;font-size:.9em;}"
    ".tag{color:#666;font-size:.85em;}"
    "</style>"
    "</head><body>");
}

// The form. The submitted password is never rendered -- it is never read
// back out of `res->submitted` by this file once decoded, so there is
// nothing here that could echo it. Every SSID goes in through sb_html().
static void render_form(sb_t *bp, const char *mac_str, const char *err,
                        const portal_view_t *view, const char *prefill) {
    static const portal_view_t fresh = { .n = 0, .last = -1 };
    if (!view) view = &fresh;
    int n = view->n < 0 ? 0 : (view->n > CONFIG_NETS_MAX ? CONFIG_NETS_MAX : view->n);
    sb_t b = *bp;
    sb_head(&b);
    sb_raw(&b, "<h1>WiFi Floppy Setup</h1><p class=\"mac\">Board ");
    sb_html(&b, mac_str, false);
    sb_raw(&b, "</p>");
    if (has_error(err, view)) {
        sb_raw(&b, "<div class=\"err\">");
        err_words(&b, err, view);
        sb_raw(&b, "</div>");
    }
    if (n > 0) {
        sb_raw(&b, "<h2>Saved networks</h2>"
                   "<p class=\"hint\">At power-on the board tries them in this order; once it "
                   "has joined one, that one goes first.</p><ul class=\"nets\">");
        for (int i = 0; i < n; i++) {
            sb_raw(&b, "<li><span>");
            sb_html(&b, view->ssid[i], false);
            if (i == view->last) sb_raw(&b, " <span class=\"tag\">(joined last)</span>");
            sb_raw(&b, "</span>");
            if (n > 1) {
                sb_raw(&b, "<form method=\"POST\" action=\"/forget\">"
                           "<input type=\"hidden\" name=\"ssid\" value=\"");
                sb_html(&b, view->ssid[i], false);
                sb_raw(&b, "\"><button type=\"submit\">Remove</button></form>");
            }
            sb_raw(&b, "</li>");
        }
        sb_raw(&b, "</ul>");
        if (n == 1)
            sb_raw(&b, "<p class=\"hint\">To replace it, add the new network first, then remove "
                       "this one.</p>");
        if (n >= CONFIG_NETS_MAX)
            sb_fmt(&b, "<p class=\"hint\">%d networks are saved, the most the board holds: remove "
                       "one to add another.</p>", CONFIG_NETS_MAX);
        sb_raw(&b, "<h2>Add a network</h2>");
    }
    sb_raw(&b,
    "<form method=\"POST\" action=\"/save\">"
    "<label for=\"ssid\">WiFi network name</label>"
    "<input type=\"text\" id=\"ssid\" name=\"ssid\" maxlength=\"32\" value=\"");
    sb_html(&b, prefill, false);
    sb_raw(&b, "\" "
    "autocapitalize=\"off\" autocorrect=\"off\" required>"
    "<label for=\"pass\">WiFi password</label>"
    "<input type=\"password\" id=\"pass\" name=\"pass\" maxlength=\"63\" "
    "minlength=\"8\" required>"
    "<p class=\"hint\">Required: open networks with no password are not "
    "supported. The board uses 2.4 GHz WiFi only, with WPA2 (not WPA3-only). "
    "Networks with a sign-in page, as in hotels and venues, do not work.</p>"
    "<label for=\"code\">Pairing code</label>"
    "<input type=\"text\" id=\"code\" name=\"code\" maxlength=\"16\" "
    "autocapitalize=\"off\" autocorrect=\"off\"");
    sb_raw(&b, view->have_code ? ">" : " required>");
    sb_raw(&b, "<p class=\"hint\">Get it in the web app: Devices, Pair a device.");
    if (view->have_code)
        sb_raw(&b, " Leave it empty to keep this board's pairing.");
    sb_raw(&b, "</p>"
    "<button type=\"submit\">Save</button>"
    "</form>"
    "</body></html>");
    *bp = b;
}

// The page a *successful* submit gets, and the reason it exists as a
// separate page rather than a re-render of the form.
//
// Final-review Important 1: this route used to answer a good POST /save
// with render_form() and the caller's `err` still in place -- so the last
// thing a user saw, at the exact moment the board had ACCEPTED their
// credentials and was tearing the AP down, was the previous attempt's
// "Wrong password" banner over an empty form. So: one distinct body, and
// `err` is deliberately not a parameter -- the previous attempt's failure
// cannot be carried into the page about the current attempt.
//
// Operator, 2026-10-09: the page names the network being joined and says
// what happens next (wording is the operator's). The SSID is attacker-shaped
// free text, so it goes in only escaped; the password and the pairing code
// are still never echoed. portal_net.c holds the AP up until the phone has
// ACKed this page (bounded), so it is actually seen.
static void render_accepted(sb_t *b, const char *mac_str, const char *ssid) {
    sb_head(b);
    sb_raw(b, "<h1>Joining ");
    sb_html(b, ssid, false);
    sb_raw(b, "\xe2\x80\xa6</h1><p class=\"mac\">Board ");
    sb_html(b, mac_str, false);
    sb_raw(b, "</p>"
    "<p>This network will now disappear.</p>"
    "<p>Watch the board's screen; when it is paired the device appears in "
    "the web app.</p>"
    "<p>If the board cannot join, this network comes back with the reason.</p>"
    "</body></html>");
}

// POST /forget's answer. The removal itself happens after this reply, in
// portal_net.c's foreground (a flash write never runs in an lwIP callback),
// so the page says "Removing", not "Removed": the setup page it links back
// to shows the outcome -- the shorter list, or the reason it did not happen.
static void render_forgetting(sb_t *b, const char *ssid) {
    sb_head(b);
    sb_raw(b, "<h1>Removing \xe2\x80\x9c");
    sb_html(b, ssid, false);
    sb_raw(b, "\xe2\x80\x9d\xe2\x80\xa6</h1>"
    "<p><a href=\"/\">Back to setup</a></p>"
    "</body></html>");
}

// POST /forget while another Remove is still being written (review M3): it
// was accepted and silently dropped while the phone said "Removing".
static void render_forget_busy(sb_t *b) {
    sb_head(b);
    sb_raw(b, "<h1>Still removing another network</h1>"
    "<p>Wait a moment, then go back and press Remove again.</p>"
    "<p><a href=\"/\">Back to setup</a></p>"
    "</body></html>");
}

static void redirect_to_portal_root(sb_t *b) {
    sb_fmt(b,
        "HTTP/1.1 302 Found\r\n"
        "Location: http://%d.%d.%d.%d/\r\n"
        "Content-Length: 0\r\n"
        "Connection: close\r\n"
        "\r\n",
        PORTAL_IP_0, PORTAL_IP_1, PORTAL_IP_2, PORTAL_IP_3);
}

static bool view_has(const portal_view_t *view, const char *ssid) {
    if (!view) return false;
    for (int i = 0; i < view->n && i < CONFIG_NETS_MAX; i++)
        if (strcmp(view->ssid[i], ssid) == 0) return true;
    return false;
}

// Renders the reply into the sb_t window; see portal_request_window().
static void route(sb_t *b, const char *method, const char *path, const char *body,
                  const char *mac_str, const char *err, const portal_view_t *view,
                  portal_result_t *res) {
    res->action = PORTAL_ACT_NONE;
    memset(&res->submitted, 0, sizeof res->submitted);
    memset(res->forget, 0, sizeof res->forget);
    const char *prefill = view ? view->prefill : "";

    if (!method || !path) { redirect_to_portal_root(b); return; }

    bool is_root = strcmp(path, "/") == 0;
    bool is_save = strcmp(path, "/save") == 0;
    bool is_forget = strcmp(path, "/forget") == 0;
    bool is_post = strcmp(method, "POST") == 0;

    if (is_save && is_post) {
        if (parse_form(body, &res->submitted)) {
            // Refused here, before anything is joined, when it could not be
            // stored afterwards (provisioning.c's prov_on_verified_submit
            // checks the same two things as a backstop). The form comes back
            // with the name kept, so only the missing part has to be typed.
            setup_form_t *f = &res->submitted;
            const char *why = NULL;
            char full_msg[96];
            if (f->ssid[0] == '\0') {
                why = "Enter the WiFi network name.";
            } else if (f->code[0] == '\0' && !(view && view->have_code)) {
                why = "Enter the pairing code. Get it in the web app: Devices, Pair a device.";
            } else if (view && view->n >= CONFIG_NETS_MAX && !view_has(view, f->ssid)) {
                snprintf(full_msg, sizeof full_msg, "%d networks are saved, the most the board "
                         "holds. Remove one below to add another.", CONFIG_NETS_MAX);
                why = full_msg;
            }
            if (why) {
                // Escaped by render_form; the SSID is copied out of res first,
                // since res->submitted is cleared (not a submit).
                char name[CONFIG_SSID_MAX + 1];
                memcpy(name, f->ssid, sizeof name);
                memset(&res->submitted, 0, sizeof res->submitted);
                render_form(b, mac_str, why, view, name);
                return;
            }
            res->action = PORTAL_ACT_SUBMIT;
            // The submit worked: a distinct page, and `err` -- which
            // describes the attempt BEFORE this one -- is not passed on.
            // See render_accepted()'s comment.
            render_accepted(b, mac_str, res->submitted.ssid);
            return;
        }
        // Not a submit: the form comes back. A caller-supplied `err` still
        // wins over the generic message, since it names an actual failure
        // (a wrong password) rather than just "that body didn't decode".
        memset(&res->submitted, 0, sizeof res->submitted);
        render_form(b, mac_str, has_error(err, view) ? err : "Please fill in every field correctly.",
                    view, prefill);
        return;
    }

    if (is_forget && is_post) {
        // Only the "ssid" field matters; the same decoder, same limits.
        setup_form_t f;
        bool got = false;
        if (body) {
            int len = (int)strlen(body);
            for (int i = 0; i < len;) {
                int s = i;
                while (i < len && body[i] != '&') i++;
                int e = i;
                if (i < len) i++;
                if (e - s > 5 && memcmp(body + s, "ssid=", 5) == 0)
                    got = urldecode(body + s + 5, e - s - 5, f.ssid, (int)sizeof f.ssid) > 0;
            }
        }
        if (!got) { redirect_to_portal_root(b); return; }
        if (view && view->forget_busy) { render_forget_busy(b); return; }   // not a forget
        memcpy(res->forget, f.ssid, sizeof res->forget);
        res->action = PORTAL_ACT_FORGET;
        render_forgetting(b, res->forget);
        return;
    }

    if (is_root) {
        render_form(b, mac_str, err, view, prefill);
        return;
    }

    // Every other path (or a method the real routes above don't accept,
    // e.g. GET /save) -- including iOS's /hotspot-detect.html and Android's
    // /generate_204 -- redirects here.
    redirect_to_portal_root(b);
}

int portal_request_window(const char *method, const char *path, const char *body,
                          const char *mac_str, const char *err, const portal_view_t *view,
                          int skip, char *out, int cap, portal_result_t *res, int *total) {
    portal_result_t local;
    if (!res) res = &local;
    if (total) *total = 0;
    if (!out || cap <= 0 || skip < 0) return 0;
    out[0] = '\0';
    sb_t b = { out, cap, skip, 0, 0, false };
    route(&b, method, path, body, mac_str, err, view, res);
    if (total) *total = b.pos;
    return b.len;
}

int portal_request(const char *method, const char *path, const char *body,
                   const char *mac_str, const char *err, const portal_view_t *view,
                   char *out, int cap, portal_result_t *res) {
    int total = 0;
    int n = portal_request_window(method, path, body, mac_str, err, view, 0, out, cap, res, &total);
    if (n != total) {   // would not fit: refused, never truncated (the contract this always had)
        if (out && cap > 0) out[0] = '\0';
        return 0;
    }
    return n;
}
