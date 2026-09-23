#include "harness.h"
#include "../src/json_scan.h"
#include <string.h>

static const char *POLL_200 =
  "{\"version\":7,\"desired\":{\"sha256\":\"abc123\",\"diskId\":\"d-1\","
  "\"gameId\":\"g-1\",\"game\":\"Lemmings\",\"diskNo\":1,\"diskCount\":2,"
  "\"writeProtected\":true}}";
static const char *POLL_EJECT = "{\"version\":9,\"desired\":null}";

static void test_reads_version_and_sha(void) {
    uint32_t v = 0; char sha[65] = {0};
    CHECK(json_u32(POLL_200, "version", &v), "version present"); CHECK_EQ_INT(v, 7);
    CHECK(json_str(POLL_200, "sha256", sha, sizeof sha), "sha present");
    CHECK(strcmp(sha, "abc123") == 0, "sha value");
}

static void test_write_protected(void) {
    bool wp = false;
    CHECK(json_bool(POLL_200, "writeProtected", &wp), "present"); CHECK(wp, "true");
}

static void test_key_shaped_substring_inside_a_string_value_is_not_a_key(void) {
    // "comment"'s value contains the bare (unquoted) text "diskId:" as
    // ordinary prose. A scanner that looks for the key text anywhere and
    // then checks for a following ':' -- rather than requiring the match
    // to be a whole, quote-delimited segment -- would stop right there
    // and report nonsense instead of continuing on to the real key.
    const char *json =
        "{\"comment\":\"see the diskId: field below\",\"diskId\":\"right\"}";
    char out[16] = {0};
    CHECK(json_str(json, "diskId", out, sizeof out), "diskId present");
    CHECK(strcmp(out, "right") == 0,
          "must resolve to the real key, not a bare mention inside a value");
}

static void test_null_desired_is_distinguishable_from_absent(void) {
    // This distinction IS the eject instruction. Getting it wrong either
    // ejects on a malformed response or never ejects at all.
    CHECK(json_is_null(POLL_EJECT, "desired"), "explicit null recognised");
    CHECK(!json_is_null(POLL_200, "desired"), "an object is not null");
    CHECK(!json_is_null(POLL_200, "nosuchkey"), "an absent key is not null");
}

static void test_json_object_extracts_and_blanks(void) {
    char body[] = "{\"version\":7,\"desired\":{\"sha256\":\"aa\"},\"instructionVersion\":3,"
                  "\"update\":{\"version\":\"1.1.0+gx\",\"sha256\":\"bb\",\"s\":\"}{\\\"\"}}";
    char obj[128];
    CHECK(json_object(body, "update", obj, sizeof obj, true), "found");
    CHECK(strcmp(obj, "{\"version\":\"1.1.0+gx\",\"sha256\":\"bb\",\"s\":\"}{\\\"\"}") == 0,
          "braces inside strings do not end the object");
    char v[16];
    CHECK(json_str(body, "sha256", v, sizeof v) && strcmp(v, "aa") == 0,
          "after blanking, the only sha256 left is the desired disk's");
    uint32_t iv = 0;
    CHECK(json_u32(body, "instructionVersion", &iv) && iv == 3, "siblings are untouched");
}
static void test_json_object_too_small_fails_cleanly(void) {
    char body[] = "{\"update\":{\"version\":\"1.1.0+gx\"}}";
    char obj[8];
    CHECK(!json_object(body, "update", obj, sizeof obj, true), "does not fit");
    CHECK(strstr(body, "1.1.0+gx") != NULL, "nothing blanked when the copy failed");
}
static void test_json_object_absent(void) {
    char body[] = "{\"version\":1}";
    char obj[32];
    CHECK(!json_object(body, "update", obj, sizeof obj, true), "absent key");
}

int main(void) {
    RUN(test_reads_version_and_sha); RUN(test_write_protected);
    RUN(test_key_shaped_substring_inside_a_string_value_is_not_a_key);
    RUN(test_null_desired_is_distinguishable_from_absent);
    RUN(test_json_object_extracts_and_blanks);
    RUN(test_json_object_too_small_fails_cleanly);
    RUN(test_json_object_absent);
    return REPORT();
}
