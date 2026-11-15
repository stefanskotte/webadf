#include "harness.h"
#include "../src/portal_http.h"
#include "../src/provisioning.h"
#include <string.h>

static char out[8192];
static portal_result_t res;
#define REQ(m, p, b, e) portal_request((m), (p), (b), "AB:CD:EF:01:02:03", (e), NULL, \
                                       out, sizeof out, &res)

static void test_root_renders_the_form(void) {
    int n = REQ("GET", "/", NULL, NULL);
    CHECK(n > 0, "rendered");
    CHECK(strstr(out, "200 OK") != NULL, "200");
    CHECK(strstr(out, "name=\"ssid\"") != NULL, "ssid field");
    CHECK(strstr(out, "name=\"pass\"") != NULL, "password field");
    CHECK(strstr(out, "name=\"code\"") != NULL, "pairing code field");
    // Testers started at the board and did not know where the code comes from (Discord, 2026-11-09).
    CHECK(strstr(out, "Devices, Pair a device") != NULL, "says where the pairing code comes from");
    CHECK(strstr(out, "2.4 GHz") != NULL, "says the board needs 2.4 GHz WiFi");
    CHECK(strstr(out, "AB:CD:EF:01:02:03") != NULL,
          "the MAC is shown so you know which board you are configuring");
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

static void test_page_has_no_external_references(void) {
    // The AP has no route to the internet; anything external hangs the page.
    REQ("GET", "/", NULL, NULL);
    CHECK(strstr(out, "http://") == NULL || strstr(out, "http://192.168.4.1") != NULL,
          "no external http references");
    CHECK(strstr(out, "https://") == NULL, "no external https references");
}

static void test_unknown_path_redirects_to_the_portal(void) {
    // This catch-all is what makes iOS and Android open the sign-in sheet.
    int n = REQ("GET", "/hotspot-detect.html", NULL, NULL);
    CHECK(n > 0, "rendered");
    CHECK(strstr(out, "302") != NULL, "302 redirect");
    CHECK(strstr(out, "Location: http://192.168.4.1/") != NULL, "to the portal root");
}

static void test_android_probe_redirects_too(void) {
    REQ("GET", "/generate_204", NULL, NULL);
    CHECK(strstr(out, "302") != NULL, "a 204 here would mean 'internet works'");
}

static void test_submit_decodes_the_form(void) {
    int n = REQ("POST", "/save", "ssid=my+net&pass=p%40ssword&code=ABC123", NULL);
    CHECK(n > 0, "rendered");
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(strcmp(res.submitted.ssid, "my net") == 0, "+ decodes to space");
    CHECK(strcmp(res.submitted.pass, "p@ssword") == 0, "%40 decodes to @");
    CHECK(strcmp(res.submitted.code, "ABC123") == 0, "code");
}

static void test_submit_with_missing_fields_is_not_a_submit(void) {
    REQ("POST", "/save", "ssid=only", NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

static void test_oversized_field_is_rejected_not_truncated(void) {
    char body[512];
    snprintf(body, sizeof body, "ssid=");
    for (int i = 0; i < 200; i++) strcat(body, "x");
    strcat(body, "&pass=password&code=ABC123");
    REQ("POST", "/save", body, NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

static void test_error_is_shown_on_the_form(void) {
    REQ("GET", "/", NULL, "Wrong password");
    CHECK(strstr(out, "Wrong password") != NULL, "the reason is displayed");
}

static void test_password_is_never_echoed(void) {
    REQ("POST", "/save", "ssid=net&pass=secret123&code=ABC123", "Wrong password");
    CHECK(strstr(out, "secret123") == NULL,
          "a submitted password must never appear in a rendered page");
}

// --- Additional coverage beyond the brief's nine tests ---

// A field seen twice must resolve to one unambiguous value, not a mix of
// the two attempts (which is exactly the "partially-populated
// device_config_t" the brief warns about).
static void test_duplicate_field_last_value_wins(void) {
    int n = REQ("POST", "/save", "ssid=first&ssid=second&pass=pw&code=ABC123", NULL);
    CHECK(n > 0, "rendered");
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(strcmp(res.submitted.ssid, "second") == 0,
          "later occurrence of a repeated field wins, cleanly");
}

// A '%' with no hex digits after it, right at the end of the buffer, must
// not read past the end of the body looking for two digits that are not
// there.
static void test_truncated_percent_escape_at_end_is_rejected(void) {
    REQ("POST", "/save", "ssid=net&pass=abc%&code=ABC123", NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);

    REQ("POST", "/save", "ssid=net&pass=abc%4&code=ABC123", NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

// A '%' followed by characters that are not hex digits at all must be
// rejected rather than silently decoded as garbage.
static void test_invalid_hex_escape_is_rejected(void) {
    REQ("POST", "/save", "ssid=net&pass=abc%zzdef&code=ABC123", NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

// POST /save with no body at all (NULL) must behave like an empty body --
// no fields present, not a submit, and not a crash.
static void test_post_save_with_null_body_is_not_a_submit(void) {
    int n = REQ("POST", "/save", NULL, NULL);
    CHECK(n > 0, "rendered without crashing");
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

// --- Final review, Important 1: a successful submit is its own page ---

// The defect: a good POST /save re-rendered the FORM, with the previous
// attempt's `err` still set. So the user who mistyped a password once,
// then typed it correctly, was served the same "Wrong password" banner at
// the exact moment the board accepted the credentials and started tearing
// the AP down. Success was indistinguishable from failure.
static void test_successful_submit_does_not_repeat_the_previous_error(void) {
    int n = REQ("POST", "/save", "ssid=net&pass=correct-horse&code=ABC123",
                "Wrong password");
    CHECK(n > 0, "rendered");
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(strstr(out, "Wrong password") == NULL,
          "the PREVIOUS attempt's error must not appear on the page that "
          "confirms THIS attempt worked");
    CHECK(strstr(out, "class=\"err\"") == NULL, "and no error block at all");
}

// It must also not merely be the form-without-an-error: an empty form is
// what a failed submit looks like, so the two bodies have to differ.
static void test_successful_submit_is_not_the_form(void) {
    char form[sizeof out];
    int fn = REQ("GET", "/", NULL, NULL);
    CHECK(fn > 0, "form rendered");
    memcpy(form, out, (size_t)fn + 1);

    int sn = REQ("POST", "/save", "ssid=net&pass=pw12345678&code=ABC123", NULL);
    CHECK(sn > 0, "submit rendered");
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(!(sn == fn && memcmp(out, form, (size_t)sn) == 0),
          "the accepted page is a different body from the plain form");
    CHECK(strstr(out, "<form") == NULL,
          "nothing to fill in again -- the credentials were accepted");
    CHECK(strstr(out, "name=\"ssid\"") == NULL, "no SSID field");
    CHECK(strstr(form, "<form") != NULL,
          "...and the plain form really does have one, so the check above "
          "is not passing vacuously");
    CHECK(strstr(out, "200 OK") != NULL, "still a 200");
}

// The submitted SSID is attacker-shaped free text. The confirmation page
// now names it (operator, 2026-10-09) -- but only escaped; the password and
// the pairing code are still never reflected at all.
static void test_accepted_page_escapes_the_ssid_and_echoes_no_secrets(void) {
    REQ("POST", "/save", "ssid=%3Cscript%3Ex&pass=hunter2xy&code=ZZTOP1", NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(strstr(out, "<script>") == NULL, "no raw reflected SSID");
    CHECK(strstr(out, "Joining &lt;script&gt;x") != NULL, "the SSID, escaped");
    CHECK(strstr(out, "hunter2xy") == NULL, "no reflected password");
    CHECK(strstr(out, "ZZTOP1") == NULL, "no reflected pairing code");
}

// The operator's wording, and the network actually being joined.
static void test_accepted_page_says_what_happens_next(void) {
    int n = REQ("POST", "/save", "ssid=Home+WiFi&pass=pw12345678&code=ABC123", NULL);
    CHECK(n > 0, "rendered");
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(strstr(out, "<h1>Joining Home WiFi\xe2\x80\xa6</h1>") != NULL, "names the network");
    CHECK(strstr(out, "This network will now disappear.") != NULL, "says the AP goes away");
    CHECK(strstr(out, "Watch the board's screen; when it is paired the device appears in "
                      "the web app.") != NULL, "says where to look next");
    CHECK(strstr(out, "If the board cannot join, this network comes back with the reason.")
          != NULL, "says what failure looks like");
    CHECK(strstr(out, "AB:CD:EF:01:02:03") != NULL, "still names the board");
    CHECK(strstr(out, "http://") == NULL && strstr(out, "https://") == NULL &&
          strstr(out, "src=") == NULL, "no external assets: the AP has no internet");
}

// portal_net.c renders into a fixed 2048-byte buffer; the worst-case SSID
// (32 characters that each escape to the longest entity) must still fit.
static void test_accepted_page_fits_with_the_worst_case_ssid(void) {
    char body[256];
    char *b = body;
    b += sprintf(b, "ssid=");
    for (int i = 0; i < 32; i++) b += sprintf(b, "%%22");   // '"' -> &quot;
    sprintf(b, "&pass=pw12345678&code=ABC123");
    char small[2048];
    int n = portal_request("POST", "/save", body, "AB:CD:EF:01:02:03", NULL, NULL,
                           small, sizeof small, &res);
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(n > 0 && n < (int)sizeof small, "fits portal_net.c's TCP_RESP_CAP");
    CHECK(strstr(small, "&quot;&quot;&quot;") != NULL, "escaped, not dropped");
    printf("  (worst-case accepted page: %d bytes)\n", n);
}

static void test_html_escape(void) {
    char o[64];
    CHECK_EQ_INT(portal_html_escape("a&b<c>d\"e'f", o, sizeof o), 30);
    CHECK(strcmp(o, "a&amp;b&lt;c&gt;d&quot;e&#39;f") == 0, "all five entities");
    CHECK_EQ_INT(portal_html_escape("x\x01y\x7fz", o, sizeof o), 5);
    CHECK(strcmp(o, "x?y?z") == 0, "control bytes become ?");
    CHECK_EQ_INT(portal_html_escape("caf\xc3\xa9", o, sizeof o), 5);
    CHECK(strcmp(o, "caf\xc3\xa9") == 0, "UTF-8 passes through");
    CHECK_EQ_INT(portal_html_escape(NULL, o, sizeof o), 0);
    CHECK(o[0] == '\0', "NULL reads as empty");
    CHECK_EQ_INT(portal_html_escape("", o, sizeof o), 0);
    // Exact fit: "&amp;" is 5 bytes + NUL = 6.
    CHECK_EQ_INT(portal_html_escape("&", o, 6), 5);
    CHECK(strcmp(o, "&amp;") == 0, "exact fit");
    CHECK_EQ_INT(portal_html_escape("&", o, 5), -1);   // refused, not truncated
    CHECK_EQ_INT(portal_html_escape("ab", o, 2), -1);
    CHECK_EQ_INT(portal_html_escape("a", o, 0), -1);
    CHECK_EQ_INT(portal_html_escape("a", NULL, 8), -1);
}

// The other half of the same route: a submit that did NOT decode still
// gets the form back, with an error on it, because there is something
// left to do.
static void test_failed_submit_still_returns_the_form_with_an_error(void) {
    REQ("POST", "/save", "ssid=only", NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
    CHECK(strstr(out, "<form") != NULL, "the form comes back");
    CHECK(strstr(out, "class=\"err\"") != NULL, "with an error block");

    // ...and a caller-supplied reason still wins over the generic one.
    REQ("POST", "/save", "ssid=only", "Network not found");
    CHECK(strstr(out, "Network not found") != NULL,
          "an actual failure reason beats \"fill in every field\"");
}

// Final review, Minor 4: both association sites hardcode
// CYW43_AUTH_WPA2_AES_PSK, so an empty password can only ever come back as
// "Could not connect". The form must not imply otherwise.
static void test_password_field_is_required(void) {
    REQ("GET", "/", NULL, NULL);
    const char *pass = strstr(out, "name=\"pass\"");
    CHECK(pass != NULL, "password field present");
    const char *end = pass ? strchr(pass, '>') : NULL;
    CHECK(end != NULL, "the input tag is terminated");
    // Isolate just this one <input ...> tag (its length computed from the
    // markup, not guessed) so "required" on a *different* field cannot
    // satisfy this check.
    char tag[256];
    size_t taglen = (size_t)(end - pass);
    CHECK(taglen < sizeof tag, "the tag fits the scratch buffer");
    memcpy(tag, pass, taglen);
    tag[taglen] = '\0';
    CHECK(strstr(tag, "required") != NULL,
          "an open network cannot work, so the field is not optional");
}

// --- Several networks and named failures (field report 2026-11-14) ---

static portal_view_t view_of(int n, const char *const *names, int last, bool have_code,
                             const char *prefill) {
    portal_view_t v;
    memset(&v, 0, sizeof v);
    v.n = n;
    for (int i = 0; i < n; i++) snprintf(v.ssid[i], sizeof v.ssid[i], "%s", names[i]);
    v.last = last;
    v.have_code = have_code;
    snprintf(v.prefill, sizeof v.prefill, "%s", prefill ? prefill : "");
    return v;
}
#define REQV(m, p, b, e, v) portal_request((m), (p), (b), "AB:CD:EF:01:02:03", (e), (v), \
                                           out, sizeof out, &res)

static int count(const char *hay, const char *needle) {
    int n = 0;
    for (const char *p = strstr(hay, needle); p; p = strstr(p + 1, needle)) n++;
    return n;
}

static void test_the_form_lists_saved_networks_with_remove_buttons(void) {
    const char *names[] = { "Home", "Phone" };
    portal_view_t v = view_of(2, names, 1, true, NULL);
    int n = REQV("GET", "/", NULL, NULL, &v);
    CHECK(n > 0, "rendered");
    CHECK(strstr(out, "Saved networks") != NULL, "a list heading");
    CHECK(strstr(out, "<span>Home</span>") != NULL, "first name");
    CHECK(strstr(out, "<span>Phone <span class=\"tag\">(joined last)</span></span>") != NULL,
          "the last joined is marked");
    CHECK_EQ_INT(count(out, "action=\"/forget\""), 2);
    CHECK(strstr(out, "name=\"ssid\" value=\"Home\"") != NULL, "each Remove names its network");
    CHECK(strstr(out, "Add a network") != NULL, "the form adds one");
    CHECK(strstr(out, "joined last first") != NULL, "says the order it tries them in");
}

static void test_the_only_network_has_no_remove_button(void) {
    const char *names[] = { "Home" };
    portal_view_t v = view_of(1, names, 0, true, NULL);
    REQV("GET", "/", NULL, NULL, &v);
    CHECK(strstr(out, "action=\"/forget\"") == NULL, "nothing to remove it with");
    CHECK(strstr(out, "add the new network first") != NULL, "says how to replace it");
}

static void test_a_fresh_board_lists_nothing_and_needs_a_code(void) {
    REQV("GET", "/", NULL, NULL, NULL);
    CHECK(strstr(out, "Saved networks") == NULL, "no list");
    const char *code = strstr(out, "name=\"code\"");
    const char *end = code ? strchr(code, '>') : NULL;
    CHECK(code && end, "code field");
    char tag[256] = "";
    if (code && end && (size_t)(end - code) < sizeof tag) memcpy(tag, code, (size_t)(end - code));
    CHECK(strstr(tag, "required") != NULL, "required on a fresh board");
}

static void test_a_paired_board_may_leave_the_code_empty(void) {
    const char *names[] = { "Home" };
    portal_view_t v = view_of(1, names, 0, true, NULL);
    REQV("GET", "/", NULL, NULL, &v);
    const char *code = strstr(out, "name=\"code\"");
    const char *end = code ? strchr(code, '>') : NULL;
    char tag[256] = "";
    if (code && end && (size_t)(end - code) < sizeof tag) memcpy(tag, code, (size_t)(end - code));
    CHECK(code && strstr(tag, "required") == NULL, "optional once a code is stored");
    CHECK(strstr(out, "Leave it empty to keep this board's pairing.") != NULL, "says what empty means");

    REQV("POST", "/save", "ssid=Hotspot&pass=pw12345678&code=", NULL, &v);
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(res.submitted.code[0] == '\0', "no code: keep the pairing");
    REQV("POST", "/save", "ssid=Hotspot&pass=pw12345678", NULL, &v);
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
}

static void test_no_code_on_a_fresh_board_is_refused_before_joining(void) {
    REQV("POST", "/save", "ssid=Venue+WiFi&pass=pw12345678&code=", NULL, NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
    CHECK(strstr(out, "Enter the pairing code.") != NULL, "says what is missing");
    CHECK(strstr(out, "value=\"Venue WiFi\"") != NULL, "the name the user typed stays in the field");
    CHECK(strstr(out, "pw12345678") == NULL, "the password does not");
}

static void test_a_fifth_network_is_refused_before_joining(void) {
    const char *names[] = { "a", "b", "c", "d" };
    portal_view_t v = view_of(4, names, 0, true, NULL);
    REQV("GET", "/", NULL, NULL, &v);
    CHECK(strstr(out, "4 networks are saved, the most the board holds") != NULL, "says it is full");
    REQV("POST", "/save", "ssid=e&pass=pw12345678&code=", NULL, &v);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
    CHECK(strstr(out, "Remove one below to add another.") != NULL, "and what to do");
    REQV("POST", "/save", "ssid=c&pass=new-password&code=", NULL, &v);
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);   // a saved name: its password changes
}

static void test_the_name_is_prefilled_and_escaped(void) {
    const char *names[] = { "Home" };
    portal_view_t v = view_of(1, names, 0, true, "Caf\xc3\xa9 \"<b>\"");
    REQV("GET", "/", NULL, NULL, &v);
    CHECK(strstr(out, "value=\"Caf\xc3\xa9 &quot;&lt;b&gt;&quot;\"") != NULL, "prefilled, escaped");
    CHECK(strstr(out, "<b>") == NULL, "never raw");
}

static void test_saved_names_are_escaped(void) {
    const char *names[] = { "<script>x", "a\"b" };
    portal_view_t v = view_of(2, names, 0, true, NULL);
    REQV("GET", "/", NULL, NULL, &v);
    CHECK(strstr(out, "<script>") == NULL, "no raw markup from an SSID");
    CHECK(strstr(out, "&lt;script&gt;x") != NULL, "escaped in the list");
    CHECK(strstr(out, "value=\"a&quot;b\"") != NULL, "and in the Remove button's value");
}

static void test_the_error_names_the_network_escaped_with_line_breaks(void) {
    REQV("GET", "/", NULL,
         "Could not join \xe2\x80\x9c<i>Venue</i>\xe2\x80\x9d: not found.\nThe board only sees 2.4 GHz",
         NULL);
    CHECK(strstr(out, "<div class=\"err\">Could not join \xe2\x80\x9c&lt;i&gt;Venue&lt;/i&gt;"
                      "\xe2\x80\x9d: not found.<br>The board only sees 2.4 GHz</div>") != NULL,
          "escaped, each line on its own");
}

static void test_remove_decodes_and_says_removing(void) {
    const char *names[] = { "My Net", "Phone" };
    portal_view_t v = view_of(2, names, 0, true, NULL);
    int n = REQV("POST", "/forget", "ssid=My+Net", NULL, &v);
    CHECK(n > 0, "rendered");
    CHECK_EQ_INT(res.action, PORTAL_ACT_FORGET);
    CHECK(strcmp(res.forget, "My Net") == 0, "the decoded name");
    CHECK(strstr(out, "Removing \xe2\x80\x9cMy Net\xe2\x80\x9d") != NULL, "says what is happening");
    CHECK(strstr(out, "href=\"/\"") != NULL, "and links back to the form");

    REQV("POST", "/forget", "ssid=%3Cb%3E", NULL, &v);
    CHECK(strstr(out, "<b>") == NULL && strstr(out, "&lt;b&gt;") != NULL, "escaped");

    REQV("POST", "/forget", NULL, NULL, &v);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
    CHECK(strstr(out, "302") != NULL, "no name: back to the form");
    REQV("GET", "/forget", NULL, NULL, &v);
    CHECK_EQ_INT(res.action, PORTAL_ACT_NONE);
}

static void test_the_hint_names_wpa3_and_sign_in_pages(void) {
    REQV("GET", "/", NULL, NULL, NULL);
    CHECK(strstr(out, "WPA3-only") != NULL, "WPA3-only networks do not work");
    CHECK(strstr(out, "sign-in page") != NULL, "captive-portal networks do not work");
}

// The largest page this route can render must fit portal_net.c's buffer.
static void test_the_worst_case_form_fits(void) {
    portal_view_t v;
    memset(&v, 0, sizeof v);
    v.n = CONFIG_NETS_MAX;
    for (int i = 0; i < CONFIG_NETS_MAX; i++) memset(v.ssid[i], '"', CONFIG_SSID_MAX);   // 6x each
    v.last = 1;
    v.have_code = true;
    memset(v.prefill, '"', CONFIG_SSID_MAX);
    // The longest error: a round over four worst-case names, every hint.
    provisioning_t p;
    memset(&p, 0, sizeof p);
    p.have_config = true;
    p.cfg.n_nets = CONFIG_NETS_MAX;
    for (int i = 0; i < CONFIG_NETS_MAX; i++) memset(p.cfg.net[i].ssid, '"', CONFIG_SSID_MAX);
    p.result[0] = NET_JOIN_NO_ADDRESS; p.result[1] = NET_JOIN_FAILED;
    p.result[2] = NET_JOIN_BAD_AUTH;   p.result[3] = NET_JOIN_NOT_FOUND;
    char err[PROV_MSG_MAX];
    CHECK(prov_round_message(&p, err, sizeof err) > 0, "the error");
    static char big[16384];
    int n = portal_request("GET", "/", NULL, "AB:CD:EF:01:02:03", err, &v, big, sizeof big, &res);
    CHECK(n > 2048, "longer than one 2 KB window: it goes out in several");
    printf("  (worst-case form: %d bytes)\n", n);

    // portal_net.c sends it 2 KB at a time, rendering each window afresh
    // (TCP_RESP_CAP). The windows, joined, must be the page byte for byte.
    static char joined[16384];
    static char win[2048];
    int off = 0, total = 0, windows = 0;
    for (;;) {
        int w = portal_request_window("GET", "/", NULL, "AB:CD:EF:01:02:03", err, &v, off,
                                      win, sizeof win, &res, &total);
        CHECK_EQ_INT(total, n);
        CHECK(w <= (int)sizeof win - 1, "a window never overruns its buffer");
        CHECK((int)strlen(win) == w, "and is NUL-terminated after what it holds");
        if (w <= 0) break;
        memcpy(joined + off, win, (size_t)w);
        off += w;
        windows++;
        if (off >= total) break;
    }
    CHECK_EQ_INT(off, n);
    CHECK(memcmp(joined, big, (size_t)n) == 0, "the windows are the page");
    CHECK_EQ_INT(windows, (n + 2046) / 2047);
    int w = portal_request_window("GET", "/", NULL, "AB:CD:EF:01:02:03", err, &v, n,
                                  win, sizeof win, &res, &total);
    CHECK_EQ_INT(w, 0);   // past the end: nothing

    static char small[256];
    CHECK_EQ_INT(portal_request("GET", "/", NULL, "AB:CD:EF:01:02:03", err, &v, small, sizeof small, &res), 0);
}

// Every window of a submit reports the submit (portal_net.c publishes only
// from the first, but a re-render must agree with it), and the accepted page
// is always ONE window: the AP comes down once the phone has ACKed it.
static void test_a_windowed_submit_is_still_one_submit(void) {
    char win[64];
    int total = 0;
    portal_request_window("POST", "/save", "ssid=net&pass=pw12345678&code=ABC123", "m", NULL, NULL,
                          100, win, sizeof win, &res, &total);
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(strcmp(res.submitted.ssid, "net") == 0, "decoded the same on any window");
    CHECK(total < 2048, "the accepted page fits one window");
}

int main(void) {
    RUN(test_root_renders_the_form);
    RUN(test_page_has_no_external_references);
    RUN(test_unknown_path_redirects_to_the_portal);
    RUN(test_android_probe_redirects_too);
    RUN(test_submit_decodes_the_form);
    RUN(test_submit_with_missing_fields_is_not_a_submit);
    RUN(test_oversized_field_is_rejected_not_truncated);
    RUN(test_error_is_shown_on_the_form);
    RUN(test_password_is_never_echoed);
    RUN(test_duplicate_field_last_value_wins);
    RUN(test_truncated_percent_escape_at_end_is_rejected);
    RUN(test_invalid_hex_escape_is_rejected);
    RUN(test_post_save_with_null_body_is_not_a_submit);
    RUN(test_successful_submit_does_not_repeat_the_previous_error);
    RUN(test_successful_submit_is_not_the_form);
    RUN(test_accepted_page_escapes_the_ssid_and_echoes_no_secrets);
    RUN(test_accepted_page_says_what_happens_next);
    RUN(test_accepted_page_fits_with_the_worst_case_ssid);
    RUN(test_html_escape);
    RUN(test_failed_submit_still_returns_the_form_with_an_error);
    RUN(test_password_field_is_required);
    RUN(test_the_form_lists_saved_networks_with_remove_buttons);
    RUN(test_the_only_network_has_no_remove_button);
    RUN(test_a_fresh_board_lists_nothing_and_needs_a_code);
    RUN(test_a_paired_board_may_leave_the_code_empty);
    RUN(test_no_code_on_a_fresh_board_is_refused_before_joining);
    RUN(test_a_fifth_network_is_refused_before_joining);
    RUN(test_the_name_is_prefilled_and_escaped);
    RUN(test_saved_names_are_escaped);
    RUN(test_the_error_names_the_network_escaped_with_line_breaks);
    RUN(test_remove_decodes_and_says_removing);
    RUN(test_the_hint_names_wpa3_and_sign_in_pages);
    RUN(test_the_worst_case_form_fits);
    RUN(test_a_windowed_submit_is_still_one_submit);
    return REPORT();
}
