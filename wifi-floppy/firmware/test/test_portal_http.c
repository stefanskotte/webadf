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
    return REPORT();
}
