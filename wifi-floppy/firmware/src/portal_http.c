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
// config_store.h (device_config_t) and dns_server.h (PORTAL_IP_*) -- so
// this links into the host test build unmodified. Task 6 binds a TCP
// listener to it.
#include "portal_http.h"
#include "dns_server.h"
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

// snprintf/vsnprintf into `out`/`cap`, normalised to this file's "0 means
// would not fit" contract (portal_http.h's return contract, and http.h's
// http_build_request follows the same shape). vsnprintf returns the
// length it *would* have written on truncation, not a negative number, so
// truncation has to be checked for explicitly.
static int emit(char *out, int cap, const char *fmt, ...) {
    if (cap <= 0) return 0;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(out, cap, fmt, ap);
    va_end(ap);
    if (n < 0 || n >= cap) return 0;
    return n;
}

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
// application/x-www-form-urlencoded and fills `cfg`'s ssid/pass/code from
// the "ssid"/"pass"/"code" fields. A field that appears more than once
// resolves to its last occurrence -- cleanly, not a mix of both -- so the
// struct is never left half-populated from two different attempts. Any
// unknown field is ignored (forward compatible with a future field this
// board does not understand yet). Returns true only if all three fields
// were seen and every value decoded within its length limit; on false,
// `cfg` must not be relied on by the caller (portal_http.h's contract:
// `submitted` is valid only when the request is a submit).
static bool parse_form(const char *body, device_config_t *cfg) {
    memset(cfg, 0, sizeof *cfg);
    bool have_ssid = false, have_pass = false, have_code = false;

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
            if (urldecode(val, vallen, cfg->ssid, (int)sizeof cfg->ssid) < 0) return false;
            have_ssid = true;
        } else if (keylen == 4 && memcmp(key, "pass", 4) == 0) {
            if (urldecode(val, vallen, cfg->pass, (int)sizeof cfg->pass) < 0) return false;
            have_pass = true;
        } else if (keylen == 4 && memcmp(key, "code", 4) == 0) {
            if (urldecode(val, vallen, cfg->code, (int)sizeof cfg->code) < 0) return false;
            have_code = true;
        }
        // any other field name: ignored
    }
    return have_ssid && have_pass && have_code;
}

// One static template, inline <style>, no external URLs of any kind (the
// AP has no route to the internet -- an external reference just hangs).
// Two %s conversions: the MAC (so whoever is holding the phone knows which
// board they are configuring) and the error block (empty when there is no
// error). The submitted password is never one of them -- it is never read
// back out of `res->submitted` by this file once decoded, so there is
// nothing here that could echo it.
static const char *PAGE_FMT =
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: text/html; charset=utf-8\r\n"
    "Connection: close\r\n"
    "\r\n"
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    "<title>WiFi Floppy Setup</title>"
    "<style>"
    "body{font-family:sans-serif;max-width:480px;margin:2em auto;padding:0 1em;}"
    "input{width:100%%;padding:.5em;margin:.3em 0 1em;box-sizing:border-box;"
    "font-size:1em;}"
    "label{font-weight:bold;display:block;}"
    "button{padding:.6em 1.2em;font-size:1em;}"
    ".err{background:#fee3e3;border:1px solid #c00;padding:.6em 1em;"
    "margin-bottom:1em;color:#900;border-radius:4px;}"
    ".mac{color:#666;font-size:.9em;}"
    ".hint{color:#666;font-size:.85em;margin:-.8em 0 1em;}"
    "</style>"
    "</head><body>"
    "<h1>WiFi Floppy Setup</h1>"
    "<p class=\"mac\">Board %s</p>"
    "%s"
    "<form method=\"POST\" action=\"/save\">"
    "<label for=\"ssid\">WiFi network name</label>"
    "<input type=\"text\" id=\"ssid\" name=\"ssid\" maxlength=\"32\" "
    "autocapitalize=\"off\" autocorrect=\"off\" required>"
    "<label for=\"pass\">WiFi password</label>"
    "<input type=\"password\" id=\"pass\" name=\"pass\" maxlength=\"63\" "
    "minlength=\"8\" required>"
    "<p class=\"hint\">Required: open networks with no password are not "
    "supported.</p>"
    "<label for=\"code\">Pairing code</label>"
    "<input type=\"text\" id=\"code\" name=\"code\" maxlength=\"16\" "
    "autocapitalize=\"off\" autocorrect=\"off\" required>"
    "<button type=\"submit\">Save</button>"
    "</form>"
    "</body></html>";

// The page a *successful* submit gets, and the reason it exists as a
// separate template rather than a re-render of the form.
//
// Final-review Important 1: this route used to answer a good POST /save
// with render_form() and the caller's `err` still in place -- so the last
// thing a user saw, at the exact moment the board had ACCEPTED their
// credentials and was tearing the AP down, was the previous attempt's
// "Wrong password" banner over an empty form. Retyping a password
// correctly looked identical to getting it wrong again. There was also no
// confirmation page at all, even though portal_net.c's publish-after-
// tcp_output ordering is justified by one.
//
// So: one distinct body, and `err` is deliberately not a parameter -- the
// previous attempt's failure cannot be carried into the page that says the
// current attempt worked. Nothing submitted is echoed either: not the
// password (§6's standing rule) and not the SSID, which is attacker-shaped
// free text that would otherwise be reflected unescaped into HTML. The MAC
// is the board's own, so it stays.
static const char *ACCEPTED_FMT =
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: text/html; charset=utf-8\r\n"
    "Connection: close\r\n"
    "\r\n"
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    "<title>WiFi Floppy Setup</title>"
    "<style>"
    "body{font-family:sans-serif;max-width:480px;margin:2em auto;padding:0 1em;}"
    ".ok{background:#e3f7e3;border:1px solid #2a2;padding:.6em 1em;"
    "margin-bottom:1em;color:#161;border-radius:4px;}"
    ".mac{color:#666;font-size:.9em;}"
    "</style>"
    "</head><body>"
    "<h1>Connecting\xe2\x80\xa6</h1>"
    "<p class=\"mac\">Board %s</p>"
    "<div class=\"ok\">Credentials accepted.</div>"
    "<p>This setup network is shutting down now, so it will disappear from "
    "your phone in a few seconds. That is what success looks like \xe2\x80\x94 "
    "you do not need to do anything else.</p>"
    "<p>If the board cannot join the network you gave it, the setup network "
    "comes back within about a minute with the reason. Rejoin it and try "
    "again only if that happens.</p>"
    "</body></html>";

static int render_accepted(char *out, int cap, const char *mac_str) {
    return emit(out, cap, ACCEPTED_FMT, mac_str ? mac_str : "");
}

static int render_form(char *out, int cap, const char *mac_str, const char *err) {
    char err_block[192];
    if (err && *err) {
        if (emit(err_block, (int)sizeof err_block,
                 "<div class=\"err\">%s</div>", err) <= 0) {
            // The (developer-supplied, not user-supplied) error string was
            // too long for the block buffer -- degrade to no error block
            // rather than fail the whole render.
            err_block[0] = '\0';
        }
    } else {
        err_block[0] = '\0';
    }
    return emit(out, cap, PAGE_FMT, mac_str ? mac_str : "", err_block);
}

static int redirect_to_portal_root(char *out, int cap) {
    return emit(out, cap,
        "HTTP/1.1 302 Found\r\n"
        "Location: http://%d.%d.%d.%d/\r\n"
        "Content-Length: 0\r\n"
        "Connection: close\r\n"
        "\r\n",
        PORTAL_IP_0, PORTAL_IP_1, PORTAL_IP_2, PORTAL_IP_3);
}

int portal_request(const char *method, const char *path, const char *body,
                   const char *mac_str, const char *err,
                   char *out, int cap, portal_result_t *res) {
    portal_result_t local;
    if (!res) res = &local;
    res->action = PORTAL_ACT_NONE;
    memset(&res->submitted, 0, sizeof res->submitted);

    if (!method || !path) return redirect_to_portal_root(out, cap);

    bool is_root = strcmp(path, "/") == 0;
    bool is_save = strcmp(path, "/save") == 0;
    bool is_post = strcmp(method, "POST") == 0;

    if (is_save && is_post) {
        if (parse_form(body, &res->submitted)) {
            res->action = PORTAL_ACT_SUBMIT;
            // The submit worked: a distinct page, and `err` -- which
            // describes the attempt BEFORE this one -- is not passed on.
            // See ACCEPTED_FMT's comment.
            return render_accepted(out, cap, mac_str);
        }
        // Not a submit: the form comes back. A caller-supplied `err` still
        // wins over the generic message, since it names an actual failure
        // (a wrong password) rather than just "that body didn't decode".
        memset(&res->submitted, 0, sizeof res->submitted);
        return render_form(out, cap, mac_str,
                           err ? err : "Please fill in every field correctly.");
    }

    if (is_root) {
        return render_form(out, cap, mac_str, err);
    }

    // Every other path (or a method the two real routes above don't
    // accept, e.g. GET /save) -- including iOS's
    // /hotspot-detect.html and Android's /generate_204 -- redirects here.
    return redirect_to_portal_root(out, cap);
}
