#include "harness.h"
#include "../src/portal_http.h"
#include <string.h>

static char out[8192];
static portal_result_t res;
#define REQ(m, p, b, e) portal_request((m), (p), (b), "AB:CD:EF:01:02:03", (e), \
                                       out, sizeof out, &res)

static void test_root_renders_the_form(void) {
    int n = REQ("GET", "/", NULL, NULL);
    CHECK(n > 0, "rendered");
    CHECK(strstr(out, "200 OK") != NULL, "200");
    CHECK(strstr(out, "name=\"ssid\"") != NULL, "ssid field");
    CHECK(strstr(out, "name=\"pass\"") != NULL, "password field");
    CHECK(strstr(out, "name=\"code\"") != NULL, "pairing code field");
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

// The submitted SSID is attacker-shaped free text; the confirmation page
// must not reflect it (unescaped or otherwise), same standing rule the
// password already had.
static void test_accepted_page_echoes_nothing_submitted(void) {
    REQ("POST", "/save", "ssid=%3Cscript%3Ex&pass=hunter2xy&code=ZZTOP1", NULL);
    CHECK_EQ_INT(res.action, PORTAL_ACT_SUBMIT);
    CHECK(strstr(out, "<script>") == NULL, "no reflected SSID");
    CHECK(strstr(out, "hunter2xy") == NULL, "no reflected password");
    CHECK(strstr(out, "ZZTOP1") == NULL, "no reflected pairing code");
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
    RUN(test_accepted_page_echoes_nothing_submitted);
    RUN(test_failed_submit_still_returns_the_form_with_an_error);
    RUN(test_password_field_is_required);
    return REPORT();
}
