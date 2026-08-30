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

static void test_null_desired_is_distinguishable_from_absent(void) {
    // This distinction IS the eject instruction. Getting it wrong either
    // ejects on a malformed response or never ejects at all.
    CHECK(json_is_null(POLL_EJECT, "desired"), "explicit null recognised");
    CHECK(!json_is_null(POLL_200, "desired"), "an object is not null");
    CHECK(!json_is_null(POLL_200, "nosuchkey"), "an absent key is not null");
}

int main(void) {
    RUN(test_reads_version_and_sha); RUN(test_write_protected);
    RUN(test_null_desired_is_distinguishable_from_absent);
    return REPORT();
}
