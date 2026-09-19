#include "harness.h"
#include "transport_fake.h"
#include "../src/device_client.h"
#include "../src/psram_image.h"
#include "../src/image_loader.h"
#include "../src/token_store.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Builds "<status_line>\r\nContent-Length: <N>\r\n\r\n<body>" with N computed
// from strlen(body) rather than hand-counted -- task 6 lost a round to six
// wrong hand-counted lengths. Review round 1, Nit: the same class of bug
// can come back through a silently-discarded snprintf result just as
// easily as a hand-typed number, so a body that would overflow `resp` (or
// any other snprintf failure) aborts the test binary loudly instead of
// quietly building a truncated fixture.
static void push_status_json(const char *status_line, const char *body) {
    char resp[512];
    int n = snprintf(resp, sizeof resp, "%s\r\nContent-Length: %zu\r\n\r\n%s",
                      status_line, strlen(body), body);
    if (n < 0 || (size_t)n >= sizeof resp) {
        fprintf(stderr, "push_status_json: body too large for the fixture buffer "
                        "(needed %d bytes, have %zu)\n", n, sizeof resp);
        abort();
    }
    fake_push_response(resp);
}

static void push_ok_json(const char *body) {
    push_status_json("HTTP/1.1 200 OK", body);
}

static char buf[128];
static device_client_t c;
static void boot(void) {
    fake_reset(); fake_set_clock(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "webadf.vercel.app", "tok");
    // psram_publish_slot() writes a process-wide static (psram_image.c),
    // so a test earlier in this binary that mounts a disk (directly, or by
    // driving dc_step through a real successful fetch) would otherwise
    // leak "mounted" into every test that runs after it -- in particular,
    // token_store_save()'s mounted-disk guard would then refuse for
    // reasons that have nothing to do with the test running. Tests that
    // want a mounted precondition call psram_publish_slot() themselves,
    // after boot().
    psram_publish_slot(SLOT_NONE);
}

static void test_cold_boot_polls_since_zero(void) {
    boot();
    c.mounted_version = 0;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "since=0") != NULL,
          "cold boot MUST poll since=0 or the device boots diskless forever");
}

// Task 5's binding ruling: transport_t.write() may accept fewer bytes than
// offered, exactly as a real socket can under backpressure. A client that
// assumes one write() call sends a whole request would pass every other
// test in this file and fail only on hardware. fake_set_max_write(1) forces
// the request out one byte at a time; dc_step must still loop until it is
// all sent.
static void test_request_survives_single_byte_writes(void) {
    boot();
    fake_set_max_write(1);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "GET /api/device/poll?since=0") != NULL,
          "a request built from single-byte writes must still arrive whole");
    CHECK(strstr(fake_last_request(), "Authorization: Bearer tok") != NULL,
          "including the part written last, not just the part written first");
}

static void test_since_does_not_advance_on_a_failed_fetch(void) {
    boot();
    // Poll names version 7...
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 125\r\n\r\n"
        "{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    // ...but the image fetch dies partway through.
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    dc_step(&c);
    CHECK_EQ_INT(c.since, 0);
    CHECK_EQ_INT(c.mounted_version, 0);
    CHECK(c.mounted_sha256[0] == 0, "nothing may be reported as mounted");
}

// Task 8's rule, exercised directly: a fetch that dies mid-body must leave
// the active PSRAM slot -- and therefore what the Amiga is holding --
// completely untouched. Not "eject then fail to refill": untouched.
static void test_current_disk_survives_a_failed_replacement_fetch(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old");
    push_ok_json(
        "{\"version\":8,\"desired\":{\"sha256\":\"new\",\"diskId\":\"d2\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    dc_step(&c);
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK(strcmp(c.mounted_sha256, "old") == 0,
          "a failed fetch must leave the Amiga holding the disk it had");
}

static void test_poll_404_keeps_the_disk_mounted(void) {
    boot();
    c.mounted_version = 5; strcpy(c.mounted_sha256, "deadbeef");
    fake_push_response("HTTP/1.1 404 Not Found\r\nContent-Length: 28\r\n\r\n"
                       "{\"error\":\"device_not_found\"}");
    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_HALTED);
    CHECK(strcmp(c.mounted_sha256, "deadbeef") == 0,
          "a deleted device row is an absence of signal, never an eject");
}

// Review round 3, NEW Important: a bare 404 status is not proof the device
// row is gone -- only the server's own explicit
// {"error":"device_not_found"} body (src/app/api/device/poll/route.ts)
// means that. Before task 7's DC_HALTED fix, treating every poll 404 as
// device_not_found was harmless-ish (the token survived DC_HALTED, and
// boards resumed on their own once a transient infra fault -- a bad
// deploy, a renamed route, a proxy misroute -- cleared). Now that
// main.c's DC_HALTED handling erases the token, misreading an ordinary
// infrastructure 404 as "device deleted" would erase every deployed
// board's token from one bad deploy, turning a transient server-side
// mistake into a fleet-wide outage that needs a human to re-pair each
// board. Uses push_status_json (not fake_push_response) so Content-Length
// is computed, not typed.
static void test_poll_404_without_device_not_found_marker_is_retryable(void) {
    boot();
    c.mounted_version = 5; strcpy(c.mounted_sha256, "deadbeef");
    push_status_json("HTTP/1.1 404 Not Found", "{\"error\":\"route_not_found\"}");
    dc_state_t s = dc_step(&c);
    CHECK(s != DC_HALTED,
          "a 404 that doesn't name device_not_found must stay retryable, not halt");
    CHECK(strcmp(c.mounted_sha256, "deadbeef") == 0,
          "still never an eject, regardless of how the 404 is classified");
}

static void test_401_halts(void) {
    boot();
    fake_push_response("HTTP/1.1 401 Unauthorized\r\nContent-Length: 24\r\n\r\n"
                       "{\"error\":\"unauthorized\"}");
    CHECK_EQ_INT(dc_step(&c), DC_HALTED);
}

static void test_204_repolls_with_same_since(void) {
    boot();
    c.since = 4;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK_EQ_INT(c.since, 4);
    CHECK(strstr(fake_last_request(), "since=4") != NULL, "same since re-polled");
}

// --- image endpoint status codes (spec §4.2, second table) ---------------
// A digest that can never succeed must not be retried forever, but must also
// not stop the device polling -- the desired state may change to something
// it CAN fetch. Retrying a 422 in a tight loop is the obvious wrong answer.

static void push_poll_desired_aa(void) {
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 125\r\n\r\n"
        "{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
}

static void poll_then_image(const char *image_response) {
    push_poll_desired_aa();
    fake_push_response(image_response);
}

static void test_image_422_does_not_retry_the_digest_but_keeps_polling(void) {
    boot();
    poll_then_image("HTTP/1.1 422 Unprocessable Entity\r\nContent-Length: 23\r\n\r\n"
                    "{\"error\":\"unencodable\"}");
    dc_state_t s = dc_step(&c);
    CHECK(s != DC_HALTED, "a bad digest must not stop the poll loop");
    CHECK_EQ_INT(c.since, 0);
    CHECK(dc_digest_is_blocked(&c, "aa"), "this digest must not be retried");
}

static void test_image_404_behaves_the_same_as_422(void) {
    boot();
    poll_then_image("HTTP/1.1 404 Not Found\r\nContent-Length: 21\r\n\r\n"
                    "{\"error\":\"not_found\"}");
    CHECK(dc_step(&c) != DC_HALTED, "keep polling");
    CHECK(dc_digest_is_blocked(&c, "aa"), "do not retry this digest");
}

static void test_image_400_is_a_firmware_bug_and_never_retried(void) {
    boot();
    poll_then_image("HTTP/1.1 400 Bad Request\r\nContent-Length: 24\r\n\r\n"
                    "{\"error\":\"invalid_body\"}");
    dc_step(&c);
    CHECK(dc_digest_is_blocked(&c, "aa"), "a malformed digest will not become valid");
}

static void test_image_503_is_retried(void) {
    boot();
    poll_then_image("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 19\r\n\r\n"
                    "{\"error\":\"no_blob\"}");
    dc_step(&c);
    CHECK(!dc_digest_is_blocked(&c, "aa"),
          "503 is transient -- blocking the digest would strand a fetchable disk");
    CHECK(c.backoff_ms > 0, "503 should back off");
}

// --- Task 7: backoff, read timeout, status reporting ---------------------

static void test_read_timeout_exceeds_the_hold(void) {
    // The poll holds 25s. A timeout at or under that tears down every poll
    // mid-hold and looks exactly like a network fault.
    CHECK(DC_POLL_TIMEOUT_MS > 25000, "read timeout must exceed the 25s hold");
}

static void test_backoff_grows_and_is_capped(void) {
    boot();
    uint32_t prev = 0;
    for (int i = 0; i < 8; i++) {
        fake_push_connect_failure();
        dc_step(&c);
        CHECK(c.backoff_ms >= prev, "backoff must not shrink on repeated failure");
        CHECK(c.backoff_ms <= DC_BACKOFF_CAP_MS, "backoff must be capped");
        prev = c.backoff_ms;
    }
    CHECK(prev > 1000, "backoff should have grown beyond the 1s floor");
}

static void test_backoff_resets_after_success(void) {
    boot();
    fake_push_connect_failure(); dc_step(&c);
    CHECK(c.backoff_ms > 0, "failure sets backoff");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n"); dc_step(&c);
    CHECK_EQ_INT(c.backoff_ms, 0);
}

// Review round 1, Important finding: with the fake clock pinned at 0 (as
// every other backoff test leaves it, via boot()'s fake_set_clock(0)),
// c->now() % 250 is 0 for the whole test, so jitter was never exercised --
// a hardcoded 0, or a missing post-jitter recap, left the suite green.
// These three assertions pin the clock away from 0 and demand an EXACT
// value, so a silently-zeroed jitter term cannot hide.

static void test_jitter_is_added_from_the_clock_not_silently_zero(void) {
    boot();
    fake_set_clock(123);
    fake_push_connect_failure(); dc_step(&c);
    // now() % 250 == 123, and this is the very first backoff (from 0), so
    // the composition is exactly floor + jitter -- no doubling, no cap.
    CHECK_EQ_INT(c.backoff_ms, DC_BACKOFF_FLOOR_MS + 123);
}

static void test_jitter_never_pushes_backoff_past_the_cap(void) {
    boot();
    fake_set_clock(249); // the maximum possible jitter term (249 % 250)
    for (int i = 0; i < 8; i++) { // fake transport's queue caps at 8 pushes
        fake_push_connect_failure();
        dc_step(&c);
    }
    // Doubling alone reaches/exceeds the cap well before 10 iterations;
    // the +249 jitter added on top must still be re-capped, not left to
    // sit above DC_BACKOFF_CAP_MS.
    CHECK_EQ_INT(c.backoff_ms, DC_BACKOFF_CAP_MS);
}

static void test_status_success_does_not_reset_poll_backoff(void) {
    // Only a genuine poll success (dc_step's 204/200) resets backoff_ms.
    // A successful status heartbeat is a different, best-effort channel --
    // an over-eager dc_backoff_reset() call inside dc_report_status (a
    // plausible copy/paste error) would silently mask real poll trouble.
    boot();
    fake_push_connect_failure(); dc_step(&c);
    uint32_t after_fail = c.backoff_ms;
    CHECK(after_fail > 0, "failure sets backoff");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL);
    CHECK_EQ_INT(c.backoff_ms, after_fail);
}

static void test_status_sends_all_six_fields(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL);
    const char *r = fake_last_request();
    CHECK(strstr(r, "mountedSha256") != NULL, "mountedSha256");
    CHECK(strstr(r, "mountedDiskId") != NULL, "mountedDiskId");
    CHECK(strstr(r, "\"version\"")   != NULL, "version");
    CHECK(strstr(r, "\"error\"")     != NULL, "error");
    CHECK(strstr(r, "psramFree")     != NULL, "psramFree");
    CHECK(strstr(r, "\"rssi\"")      != NULL, "rssi");
}

static void test_unmounted_reports_null_not_omitted(void) {
    // null means "I hold no disk" -- an honest report. Omitting the key means
    // "no opinion" and leaves the server's column stale.
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL);
    CHECK(strstr(fake_last_request(), "\"mountedSha256\":null") != NULL,
          "an unmounted device must report null explicitly");
}

// --- Task 10: a genuinely successful image fetch really publishes --------
// Every other test above that reaches dc_fetch_image's 200 branch uses a
// truncated or non-200 response, so none of them ever call
// image_parse_end()/psram_publish_slot() for real. Task 8's fill-then-
// publish memory-barrier ordering is only load-bearing once that actually
// happens; this pushes a real, complete, minimal WFMF image and checks it
// lands -- and that writeProtected from the poll body reaches
// device_client_t (device_client.h's mounted_write_protected).

static void put_u32_le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

// One payload byte (8 bits) per track: valid per the WFMF container, and
// small enough that the whole image plus HTTP framing fits comfortably
// inside transport_fake's FAKE_MAX_RESPONSE_BYTES (8192).
static int build_minimal_full_image(uint8_t *out) {
    put_u32_le(out + 0, IMAGE_MAGIC);
    put_u32_le(out + 4, IMAGE_VERSION);
    put_u32_le(out + 8, NUM_TRACKS);
    put_u32_le(out + 12, 0);
    int at = 16;
    for (int t = 0; t < NUM_TRACKS; t++) {
        put_u32_le(out + at, 8); at += 4;    // 8 bits = 1 payload byte
        out[at++] = (uint8_t)t;              // payload
        out[at++] = 0; out[at++] = 0; out[at++] = 0;  // pad to 4-byte boundary
    }
    return at;
}

// A real WFMF image embeds NUL bytes from byte 4 onward (IMAGE_VERSION=1
// as little-endian u32 is 01 00 00 00), so it cannot travel through
// fake_push_response's strlen()-based C-string API -- fake_push_response_bytes
// takes an exact length instead.
static void push_image_response(void) {
    static uint8_t body[4096];
    int body_len = build_minimal_full_image(body);
    char header[128];
    int hn = snprintf(header, sizeof header,
        "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", body_len);
    if (hn < 0 || (size_t)hn >= sizeof header) abort();
    static uint8_t full[sizeof header + sizeof body];
    memcpy(full, header, (size_t)hn);
    memcpy(full + hn, body, (size_t)body_len);
    fake_push_response_bytes(full, hn + body_len);
}

// A short, definitely-not-WFMF body with a Content-Length that matches it
// exactly -- the body arrives whole (r.body_complete == true), but
// image_parse_end() must still refuse it. Distinguishes "the bytes arrived"
// from "the bytes are a disk" -- dc_fetch_image's old dc_discard_sink-based
// code could never fail this way, since it never looked at the bytes at all.
static void push_corrupt_image_response(void) {
    static uint8_t body[32];
    memset(body, 0xAB, sizeof body);   // not the WFMF magic under any interpretation
    char header[128];
    int hn = snprintf(header, sizeof header,
        "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", (int)sizeof body);
    if (hn < 0 || (size_t)hn >= sizeof header) abort();
    static uint8_t full[sizeof header + sizeof body];
    memcpy(full, header, (size_t)hn);
    memcpy(full + hn, body, sizeof body);
    fake_push_response_bytes(full, hn + (int)sizeof body);
}

static void test_corrupt_image_body_blocks_the_digest_but_does_not_publish(void) {
    boot();
    int before = psram_active_slot();
    push_poll_desired_aa();
    push_corrupt_image_response();

    dc_state_t s = dc_step(&c);

    CHECK(s != DC_HALTED, "a corrupt image must not stop the poll loop");
    CHECK_EQ_INT(psram_active_slot(), before);
    CHECK(c.mounted_sha256[0] == '\0', "must not be reported as mounted");
    CHECK(dc_digest_is_blocked(&c, "aa"), "this digest must not be retried");
}

static void test_successful_image_fetch_publishes_and_reflects_write_protected(void) {
    boot();
    int target = psram_inactive_slot();
    push_poll_desired_aa();
    push_image_response();

    dc_state_t s = dc_step(&c);

    CHECK_EQ_INT(s, DC_IDLE_POLL);
    CHECK_EQ_INT(psram_active_slot(), target);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "the fetched disk must actually be mounted");
    CHECK_EQ_INT((int)c.since, 7);
    CHECK(!c.mounted_write_protected,
          "writeProtected:false in the poll body must reach device_client_t");
}


// --- observations: what the OLED is told -----------------------------
// The server has always sent the disk's title, number and label in the poll
// body; this device discarded them until the display needed them. These
// tests exist because the alternative place to find out whether a title is
// right is a 0.91" panel, and that is exactly the verification loop the
// display work was meant to get out of.
#define MAX_OBS 64
static dc_obs_t seen[MAX_OBS];
static int n_seen;
static void record(void *ctx, const dc_obs_t *o) {
    (void)ctx;
    if (n_seen < MAX_OBS) seen[n_seen] = *o;
    n_seen++;
}
static void watch(void) { n_seen = 0; dc_set_observer(&c, record, NULL); }
static const dc_obs_t *last_of(dc_obs_kind_t k) {
    for (int i = (n_seen < MAX_OBS ? n_seen : MAX_OBS) - 1; i >= 0; i--)
        if (seen[i].kind == k) return &seen[i];
    return NULL;
}

static void test_the_disk_title_is_read_from_the_poll_body(void) {
    boot(); watch();
    push_ok_json("{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\","
                 "\"gameId\":\"g\",\"game\":\"Sensible Soccer\",\"label\":\"Boot\","
                 "\"diskNo\":1,\"diskCount\":2,\"writeProtected\":true}}");
    push_image_response();
    dc_step(&c);

    const dc_obs_t *m = last_of(DC_OBS_MOUNTED);
    CHECK(m != NULL, "a successful mount must be observable");
    if (m) {
        CHECK(strcmp(m->title, "Sensible Soccer") == 0, "the title must survive the wire");
        CHECK(strcmp(m->label, "Boot") == 0, "and so must the label");
        CHECK_EQ_INT((int)m->disk_no, 1);
        CHECK_EQ_INT((int)m->disk_count, 2);
    }
}

static void test_an_eject_clears_the_title(void) {
    // Otherwise the panel goes on naming a disk the drive no longer holds,
    // which is worse than a blank line: it is a confident wrong answer.
    boot(); watch();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa");
    strcpy(c._fetch_title, "Sensible Soccer");
    push_ok_json("{\"version\":9,\"desired\":null}");
    dc_step(&c);

    const dc_obs_t *e = last_of(DC_OBS_EJECTED);
    CHECK(e != NULL, "an eject must be observable");
    if (e) CHECK(e->title[0] == '\0', "an ejected drive must not still name a disk");
}

static void test_an_already_mounted_disk_is_still_named(void) {
    // The reboot case. A board that comes up with its disk already in PSRAM
    // never runs the fetch path again, so if only the fetch announced the
    // title the panel would read LOADED with no name until the next swap.
    boot(); watch();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa");
    push_ok_json("{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\","
                 "\"gameId\":\"g\",\"game\":\"Lemmings\",\"diskNo\":1,"
                 "\"diskCount\":1,\"writeProtected\":true}}");
    dc_step(&c);

    const dc_obs_t *m = last_of(DC_OBS_MOUNTED);
    CHECK(m != NULL, "a reconciliation poll must still name the disk");
    if (m) CHECK(strcmp(m->title, "Lemmings") == 0, "and name it correctly");
}

static void test_a_missing_title_never_stops_a_mount(void) {
    // The drive's job is to hold the disk. A blank line on a display is not
    // a reason to refuse one, so an absent title must cost nothing but the
    // title itself.
    boot(); watch();
    push_poll_desired_aa();          // fixture carries no "label"
    push_image_response();
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(st, DC_IDLE_POLL);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "the disk must mount regardless");
}

static void test_a_stale_title_cannot_survive_into_a_different_disk(void) {
    boot(); watch();
    strcpy(c._fetch_title, "Previous Disk");
    strcpy(c._fetch_label, "Old Label");
    // This body names a disk but carries NO title fields at all.
    push_ok_json("{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\","
                 "\"gameId\":\"g\",\"writeProtected\":true}}");
    push_image_response();
    dc_step(&c);
    const dc_obs_t *m = last_of(DC_OBS_MOUNTED);
    CHECK(m != NULL, "still mounts");
    if (m) CHECK(m->title[0] == '\0',
                 "a title from the PREVIOUS disk must not be shown for this one");
}

static void test_progress_is_reported_once_per_percent(void) {
    // The body sink runs once per 4 KB read -- ~500 times for a 2 MB image.
    // An observation per call would be ~400 publishes that render the exact
    // same frame, on a core that is also running the TLS read loop.
    boot(); watch();
    push_poll_desired_aa();
    push_image_response();
    dc_step(&c);
    int n = 0;
    for (int i = 0; i < n_seen && i < MAX_OBS; i++)
        if (seen[i].kind == DC_OBS_FETCH_PROGRESS) n++;
    CHECK(n <= 101, "progress must be throttled to whole percent changes");
}

static void test_an_absent_observer_changes_nothing(void) {
    // The display must not be able to break a mount. Same fixtures, no
    // observer, same outcome.
    boot();
    dc_set_observer(&c, NULL, NULL);
    push_poll_desired_aa();
    push_image_response();
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(st, DC_IDLE_POLL);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "mount is unaffected by observation");
}

// --- Task 10: registration -------------------------------------------
// dc_register is the one request in the protocol with no bearer -- the
// pairing code IS the credential (device_client.h) -- and is called while
// `c` is otherwise fully provisioned (boot() gives it token "tok") to
// prove it never sends that token regardless.

static void test_register_body_has_the_three_required_fields(void) {
    boot(); token_store_erase();
    push_ok_json("{\"token\":\"t-1\",\"deviceId\":\"d-1\",\"name\":\"Device x\"}");
    CHECK_EQ_INT(dc_register(&c, "ABC123", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_OK);
    const char *r = fake_last_request();
    CHECK(strstr(r, "pairingCode")     != NULL, "pairingCode");
    CHECK(strstr(r, "firmwareVersion") != NULL, "firmwareVersion");
    CHECK(strstr(r, "macAddress")      != NULL, "macAddress");
    CHECK(strstr(r, "Authorization")   == NULL,
          "register is deliberately unauthenticated -- the code IS the credential");
}

static void test_register_stores_the_returned_token(void) {
    boot(); token_store_erase();
    push_ok_json("{\"token\":\"t-1\",\"deviceId\":\"d-1\",\"name\":\"Device x\"}");
    CHECK_EQ_INT(dc_register(&c, "ABC123", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_OK);
    CHECK(token_store_load(buf, sizeof buf), "token persisted");
    CHECK(strcmp(buf, "t-1") == 0, "the returned token");
}

static void test_bad_code_does_not_store_anything(void) {
    boot(); token_store_erase();
    // The body carries a `token` field on purpose, alongside the error --
    // a fixture with no `token` key at all would let this test pass even
    // if dc_register() stopped checking the status code entirely (a 200
    // check dropped in favour of "did the body have a token" would still
    // reject this response, just for the wrong reason, and never be
    // caught). Only actually honouring the 400 keeps this out of the
    // store.
    push_status_json("HTTP/1.1 400 Bad Request",
        "{\"error\":\"invalid_or_used_code\",\"token\":\"should-not-be-used\"}");
    CHECK_EQ_INT(dc_register(&c, "WRONG", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_BAD_CODE);
    CHECK(!token_store_load(buf, sizeof buf), "nothing may be stored on failure");
}

// Task 7, spec D-4b-4: invalid_or_used_code is terminal, not retryable --
// main.c routes it straight to provisioning.h's
// prov_on_pairing_code_rejected() instead of looping dc_register() under
// backoff forever. DC_REG_BAD_CODE is what lets the caller tell this
// apart from every other failure shape, which stays DC_REG_RETRY.
static void test_invalid_code_is_reported_as_bad_code_not_retry(void) {
    boot(); token_store_erase();
    push_status_json("HTTP/1.1 400 Bad Request",
        "{\"error\":\"invalid_or_used_code\"}");
    CHECK_EQ_INT(dc_register(&c, "WRONG", "4b.0", "aa:bb:cc:dd:ee:ff"), DC_REG_BAD_CODE);
}

// A 400 for any other reason (a malformed body, say) is NOT the terminal
// case above -- it must stay retryable, or a transient server-side bug
// would strand a device in the portal for no recoverable reason.
static void test_other_400_is_still_retryable(void) {
    boot(); token_store_erase();
    push_status_json("HTTP/1.1 400 Bad Request",
        "{\"error\":\"invalid_body\"}");
    CHECK_EQ_INT(dc_register(&c, "ABC123", "4b.0", "aa:bb:cc:dd:ee:ff"), DC_REG_RETRY);
}

// Review round 1, Important I-2: main.c's registration loop reads
// c->backoff_ms and sleeps on it between attempts (exactly like the poll
// loop does for dc_step()) -- but dc_register() itself has to be the thing
// that grows it, or a fresh device_client_t's backoff_ms stays 0 forever
// and that sleep is always DC_BACKOFF_FLOOR_MS flat, hammering the
// deliberately unauthenticated /api/device/register endpoint at 1 req/s
// on a bad or already-used pairing code. Mirrors
// test_backoff_grows_and_is_capped's shape, against dc_register instead of
// dc_step.
static void test_register_backs_off_on_repeated_failure(void) {
    boot(); token_store_erase();
    uint32_t prev = 0;
    for (int i = 0; i < 5; i++) {
        push_status_json("HTTP/1.1 400 Bad Request",
            "{\"error\":\"invalid_or_used_code\"}");
        CHECK_EQ_INT(dc_register(&c, "WRONG", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_BAD_CODE);
        CHECK(c.backoff_ms >= prev, "backoff must not shrink on repeated failure");
        prev = c.backoff_ms;
    }
    CHECK(prev > 0,
          "a failed dc_register must grow backoff_ms, or main.c's register "
          "loop hammers the endpoint at a flat 1 req/s forever");
}


// --- Final review, Important 2: a blocked digest must not become a
// request storm -------------------------------------------------------
//
// `since` advances ONLY in dc_complete_transition, i.e. only after a real
// swap or a real eject. Every blocked-digest exit leaves it where it was.
// The server (src/app/api/device/poll/route.ts) answers a poll the instant
// `version > since`, so once a permanently-unfetchable disk is desired,
// every poll returns 200 immediately, forever. main.c sleeps only on the
// delay device_client.c hands it, so if these exits return DC_IDLE_POLL
// with backoff_ms untouched, core1 re-polls at full TLS-handshake rate
// with no pause at all -- against Vercel, indefinitely.
//
// These tests pin the floor. They assert on the DELAY, not on a particular
// state name, because the delay is the thing main.c actually sleeps on.

static void test_a_blocked_digest_never_repolls_without_a_delay(void) {
    boot();
    // Cycle 1: the poll names "aa" and the image endpoint permanently
    // rejects it, so "aa" joins the blocked set and no transition happens.
    poll_then_image("HTTP/1.1 422 Unprocessable Entity\r\nContent-Length: 23\r\n\r\n"
                    "{\"error\":\"unencodable\"}");
    dc_step(&c);
    CHECK(dc_digest_is_blocked(&c, "aa"), "precondition: the digest is blocked");
    CHECK_EQ_INT((int)c.since, 0);

    // Cycles 2..6: the server keeps answering the same 200 immediately,
    // because `since` never moved. Each one must come back with a real,
    // non-shrinking delay for main.c to sleep on.
    uint32_t prev = 0;
    for (int i = 0; i < 5; i++) {
        push_poll_desired_aa();
        dc_state_t s = dc_step(&c);
        CHECK_EQ_INT(s, DC_BACKOFF);
        CHECK(c.backoff_ms >= DC_BACKOFF_FLOOR_MS,
              "a 200 the device could not act on must leave main.c a delay "
              "to sleep on, or this is an unthrottled request storm");
        CHECK(c.backoff_ms >= prev, "the delay must not shrink");
        prev = c.backoff_ms;
    }
    CHECK(prev > DC_BACKOFF_FLOOR_MS,
          "the delay must GROW across repeats, not sit pinned at the floor -- "
          "an unconditional dc_backoff_reset() on any 200 would pin it there");
    CHECK_EQ_INT((int)c.since, 0);
    CHECK(c.mounted_sha256[0] == '\0', "still nothing mounted, still not ejected");
}

// The same floor, one cycle earlier: the very poll whose image fetch fails
// permanently (not just the later short-circuited ones) must already come
// back with a delay.
static void test_the_fetch_that_blocks_the_digest_also_backs_off(void) {
    boot();
    poll_then_image("HTTP/1.1 404 Not Found\r\nContent-Length: 21\r\n\r\n"
                    "{\"error\":\"not_found\"}");
    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_BACKOFF);
    CHECK(c.backoff_ms >= DC_BACKOFF_FLOOR_MS, "must not re-poll instantly");
    CHECK(s != DC_HALTED, "and must still not stop the poll loop");
}

// A 200 whose body is a well-formed WFMF-less mess blocks the digest too
// (image_parse_end() fails), and takes the same floor.
static void test_a_corrupt_image_body_also_backs_off(void) {
    boot();
    push_poll_desired_aa();
    push_corrupt_image_response();
    CHECK_EQ_INT(dc_step(&c), DC_BACKOFF);
    CHECK(c.backoff_ms >= DC_BACKOFF_FLOOR_MS, "must not re-fetch instantly");
    CHECK(dc_digest_is_blocked(&c, "aa"), "and must not retry the digest");
}

// The other half of the same change: dc_step no longer resets backoff_ms
// on ANY 200, only on a productive one. These two pin that a real
// transition still clears it, so the throttle above cannot creep into the
// happy path and slow down a healthy device.
static void test_a_successful_swap_still_clears_the_backoff(void) {
    boot();
    fake_push_connect_failure(); dc_step(&c);
    CHECK(c.backoff_ms > 0, "precondition: a failure has set a backoff");

    push_poll_desired_aa();
    push_image_response();
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(c.backoff_ms, 0);
    CHECK_EQ_INT((int)c.since, 7);
}

static void test_an_eject_still_clears_the_backoff(void) {
    boot();
    fake_push_connect_failure(); dc_step(&c);
    CHECK(c.backoff_ms > 0, "precondition: a failure has set a backoff");

    push_ok_json("{\"version\":9,\"desired\":null}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(c.backoff_ms, 0);
    CHECK_EQ_INT((int)c.since, 9);
}

// --- Final review, Minor 6: a truncated poll body is never acted on ----
// readDesired() emits `sha256` first and `writeProtected` LAST, after the
// free-text `game` title, so an over-long title drops exactly the field
// whose absence fails open once write-back exists. Acting on the prefix is
// the wrong answer; so is silently defaulting. Refuse the body.
static void test_an_over_long_poll_body_is_refused_not_truncated(void) {
    boot();
    static char body[6000];
    static char title[3000];
    memset(title, 'A', sizeof title - 1);
    title[sizeof title - 1] = '\0';
    int bn = snprintf(body, sizeof body,
        "{\"version\":11,\"desired\":{\"sha256\":\"bb\",\"diskId\":\"d1\","
        "\"gameId\":\"g\",\"game\":\"%s\",\"diskNo\":1,\"diskCount\":1,"
        "\"label\":\"L\",\"writeProtected\":false}}", title);
    if (bn < 0 || (size_t)bn >= sizeof body) abort();

    // Content-Length computed from the body, never hand-counted.
    static char resp[6200];
    int rn = snprintf(resp, sizeof resp, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s",
                      bn, body);
    if (rn < 0 || (size_t)rn >= sizeof resp) abort();
    fake_push_response(resp);

    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_BACKOFF);
    CHECK_EQ_INT((int)c.since, 0);
    CHECK(c.mounted_sha256[0] == '\0',
          "a body whose tail was cut off must not be acted on at all");
    CHECK(!dc_digest_is_blocked(&c, "bb"),
          "and must not poison the digest -- the digest itself is fine");
    CHECK_EQ_INT(fake_request_count(), 1);
}

// --- Task 3 (write-back 2b): hold, force refetch, adopt, post ------------

static bool hold_true(void *ctx)  { (void)ctx; return true; }
static bool hold_false(void *ctx) { (void)ctx; return false; }

static void hold_keeps_the_disk_through_a_swap(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); strcpy(c.mounted_disk_id, "d1");
    c.since = 3; c.mounted_version = 3;
    dc_set_hold(&c, hold_true, NULL);
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"new\",\"diskId\":\"d2\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_IDLE_POLL);
    CHECK_EQ_INT(fake_request_count(), 1);            // the poll, and no image fetch
    CHECK(strcmp(c.mounted_sha256, "old") == 0, "D7: never swap away from unsent writes");
    CHECK_EQ_INT(c.since, 3);                         // asked again once the hold lifts
    CHECK_EQ_INT(psram_active_slot(), 0);
}

static void hold_keeps_the_disk_through_an_eject(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); c.since = 3; c.mounted_version = 3;
    dc_set_hold(&c, hold_true, NULL);
    push_ok_json("{\"version\":9,\"desired\":null}");
    dc_step(&c);
    CHECK(strcmp(c.mounted_sha256, "old") == 0, "D7: never eject with unsent writes");
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK_EQ_INT(c.since, 3);
}

static void a_lifted_hold_lets_the_eject_through(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); c.since = 3;
    dc_set_hold(&c, hold_false, NULL);
    push_ok_json("{\"version\":9,\"desired\":null}");
    dc_step(&c);
    CHECK(c.mounted_sha256[0] == '\0', "no pending writes: the eject happens");
    CHECK_EQ_INT(psram_active_slot(), SLOT_NONE);
}

static void force_refetch_fetches_the_digest_already_mounted(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa"); c.since = 7; c.mounted_version = 7;
    dc_force_refetch(&c);
    CHECK_EQ_INT(c.since, 0);
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    push_image_response();
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "GET /api/device/image/aa") != NULL,
          "the server's image won: the board's copy must be replaced even though the digest matches");
    CHECK_EQ_INT(c.mounted_version, 8);
}

static void adopt_makes_the_next_poll_a_no_op(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa"); c.since = 7;
    dc_adopt_image(&c, "bb");
    CHECK(strcmp(c.mounted_sha256, "bb") == 0, "adopted");
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"bb\",\"diskId\":\"d1\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 1);            // no image fetch: already held
    CHECK_EQ_INT(c.mounted_version, 8);
}

static void post_sends_a_binary_body_whole(void) {
    boot();
    static uint8_t body[DC_POST_BODY_MAX];
    for (int i = 0; i < DC_POST_BODY_MAX; i++) body[i] = (uint8_t)(i * 13);
    push_ok_json("{\"staged\":3}");
    char resp[64];
    int st = dc_post(&c, "/api/device/write?track=3", "application/octet-stream",
                     body, DC_POST_BODY_MAX, resp, sizeof resp);
    CHECK_EQ_INT(st, 200);
    CHECK(strcmp(resp, "{\"staged\":3}") == 0, "response body returned");
    CHECK(strstr(fake_last_request(), "POST /api/device/write?track=3 HTTP/1.1") != NULL, "line");
    CHECK(strstr(fake_last_request(), "Content-Length: 5632\r\n") != NULL, "length");
    int n = fake_last_request_len();
    CHECK(n > DC_POST_BODY_MAX, "head + body");
    CHECK(memcmp(fake_last_request() + n - DC_POST_BODY_MAX, body, DC_POST_BODY_MAX) == 0,
          "the body arrives byte for byte, NULs and all");
}

static void post_reports_a_dead_link_and_a_dead_token(void) {
    boot();
    char resp[64];
    fake_push_connect_failure();
    CHECK_EQ_INT(dc_post(&c, "/c", NULL, NULL, 0, resp, sizeof resp), -1);
    push_status_json("HTTP/1.1 401 Unauthorized", "{\"error\":\"unauthorized\"}");
    CHECK_EQ_INT(dc_post(&c, "/c", NULL, NULL, 0, resp, sizeof resp), 401);
    CHECK_EQ_INT(c.state, DC_HALTED);
}

int main(void) {
    // Only test_successful_image_fetch_publishes_and_reflects_write_protected
    // needs real PSRAM backing (everything else in this file either never
    // reaches image_parse_feed, or only pokes psram_publish_slot()'s
    // bookkeeping directly) -- set up once, matching test_psram_image.c's
    // own main().
    size_t psram_len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *psram_mem = malloc(psram_len);
    psram_image_set_backing(psram_mem, psram_len);

    RUN(test_cold_boot_polls_since_zero);
    RUN(test_request_survives_single_byte_writes);
    RUN(test_since_does_not_advance_on_a_failed_fetch);
    RUN(test_current_disk_survives_a_failed_replacement_fetch);
    RUN(test_poll_404_keeps_the_disk_mounted);
    RUN(test_poll_404_without_device_not_found_marker_is_retryable);
    RUN(test_401_halts);
    RUN(test_204_repolls_with_same_since);
    RUN(test_image_422_does_not_retry_the_digest_but_keeps_polling);
    RUN(test_image_404_behaves_the_same_as_422);
    RUN(test_image_400_is_a_firmware_bug_and_never_retried);
    RUN(test_image_503_is_retried);
    RUN(test_read_timeout_exceeds_the_hold);
    RUN(test_backoff_grows_and_is_capped);
    RUN(test_backoff_resets_after_success);
    RUN(test_jitter_is_added_from_the_clock_not_silently_zero);
    RUN(test_jitter_never_pushes_backoff_past_the_cap);
    RUN(test_status_success_does_not_reset_poll_backoff);
    RUN(test_status_sends_all_six_fields);
    RUN(test_unmounted_reports_null_not_omitted);
    RUN(test_corrupt_image_body_blocks_the_digest_but_does_not_publish);
    RUN(test_successful_image_fetch_publishes_and_reflects_write_protected);
    RUN(test_register_body_has_the_three_required_fields);
    RUN(test_register_stores_the_returned_token);
    RUN(test_bad_code_does_not_store_anything);
    RUN(test_invalid_code_is_reported_as_bad_code_not_retry);
    RUN(test_other_400_is_still_retryable);
    RUN(test_register_backs_off_on_repeated_failure);
    RUN(test_a_blocked_digest_never_repolls_without_a_delay);
    RUN(test_the_fetch_that_blocks_the_digest_also_backs_off);
    RUN(test_a_corrupt_image_body_also_backs_off);
    RUN(test_a_successful_swap_still_clears_the_backoff);
    RUN(test_an_eject_still_clears_the_backoff);
    RUN(test_an_over_long_poll_body_is_refused_not_truncated);

    RUN(hold_keeps_the_disk_through_a_swap);
    RUN(hold_keeps_the_disk_through_an_eject);
    RUN(a_lifted_hold_lets_the_eject_through);
    RUN(force_refetch_fetches_the_digest_already_mounted);
    RUN(adopt_makes_the_next_poll_a_no_op);
    RUN(post_sends_a_binary_body_whole);
    RUN(post_reports_a_dead_link_and_a_dead_token);

    // The observation tests run BEFORE the backing is released: several of
    // them drive a real fetch, which writes into PSRAM. Appending them after
    // free(psram_mem) -- which is where they first landed -- is a
    // heap-use-after-free that macOS tolerated silently and Linux turned into
    // a segfault on the first CI run.
    RUN(test_the_disk_title_is_read_from_the_poll_body);
    RUN(test_an_eject_clears_the_title);
    RUN(test_an_already_mounted_disk_is_still_named);
    RUN(test_a_missing_title_never_stops_a_mount);
    RUN(test_a_stale_title_cannot_survive_into_a_different_disk);
    RUN(test_progress_is_reported_once_per_percent);
    RUN(test_an_absent_observer_changes_nothing);

    // Last, so nothing below can touch it. Anything added after this line and
    // reaching image_parse_feed() writes to freed memory.
    free(psram_mem);
    return REPORT();
}
