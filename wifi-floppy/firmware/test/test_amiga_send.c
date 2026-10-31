// amiga_send.c against a scripted fake of the socket and the server (PaulaNET Phase 4, spec 2026-10-16 §2-3).
#include <stdio.h>
#include <string.h>
#include "harness.h"
#include "../src/amiga_send.h"

// --- the fake ---------------------------------------------------------------
static struct {
    int sock;                  // AS_SOCK_*
    int connects;
    uint32_t ip; uint16_t port;
    char out[70000]; int out_n; int accept_max; int budget;   // all send() accepted; bytes per pass (0 = unlimited)
    char in[16][AS_LINE_MAX + 1]; int in_head, in_tail;   // lines Receive will answer
    bool recv_closed;
    char queue[AS_QUEUE_BYTES + 1]; int queue_status; int queue_fetches;
    uint8_t file[70000]; uint32_t file_len; int chunk_error; int chunk_fetches;
    uint32_t last_off;
    char posted_id[64]; char posted[600]; int posts; int post_status;
    as_raw_t *raw; int arms;                           // the armed raw section (amiga_tcp.c's role)
    as_raw_t *armed;                                   // exactly what the engine last armed (NULL: disarmed)
    char partial[AS_LINE_MAX + 1]; int partial_n;      // a line from the Amiga being built
    int opens, open_status; char open_json[AS_UP_JSON_MAX]; char open_resp[256];
    int chunks, chunk_status; uint32_t chunk_offs[300], chunk_lens[300]; uint8_t stored[200000]; uint32_t stored_len;
    char chunk_id[64]; char close_id[64];              // the upload id each request was made for
    int lose_answer;                                   // the next chunk is stored but answered -1 (a lost answer)
    int closes, close_status; char close_json[128]; char close_resp[512];
    // NET: volumes (fw 1.22.0)
    char reqs[AR_FETCH_BYTES + 1]; int req_status; int req_fetches;   // what GET /api/device/req returns next
    char req_rid[12][48]; char req_body[12][AR_BODY_BYTES + 1]; int req_posts; int req_post_status;
    uint32_t now;
} F;

static int f_connect(void *c, uint32_t ip, uint16_t port) { (void)c; F.connects++; F.ip = ip; F.port = port; F.sock = AS_SOCK_CONNECTING; return 0; }
static int f_state(void *c) { (void)c; return F.sock; }
static int f_send(void *c, const uint8_t *b, int n) {
    (void)c;
    if (F.sock != AS_SOCK_OPEN) return -1;
    int k = n;
    if (F.accept_max) { if (k > F.budget) k = F.budget; F.budget -= k; }   // a send buffer that drains once per pass
    memcpy(F.out + F.out_n, b, (size_t)k); F.out_n += k; F.out[F.out_n] = 0;
    return k;
}
static int f_recv(void *c, char *out, int cap) {
    (void)c;
    if (F.in_head != F.in_tail) { snprintf(out, (size_t)cap, "%s", F.in[F.in_head]); F.in_head = (F.in_head + 1) % 16; return 1; }
    return (F.recv_closed || F.sock == AS_SOCK_CLOSED) ? -1 : 0;
}
static void f_close(void *c) { (void)c; F.sock = AS_SOCK_CLOSED; }
static int f_queue(void *c, char *buf, int cap) {
    (void)c; F.queue_fetches++;
    if (F.queue_status) return -1;
    int n = (int)strlen(F.queue); if (n > cap) return -1;
    memcpy(buf, F.queue, (size_t)n); return n;
}
static int f_chunk(void *c, const char *id, uint32_t off, uint32_t len, uint8_t *buf) {
    (void)c; (void)id; F.chunk_fetches++; F.last_off = off;
    if (F.chunk_error) return F.chunk_error;
    memcpy(buf, F.file + off, len); return (int)len;
}
static int f_post(void *c, const char *id, const char *json) {
    (void)c; F.posts++; snprintf(F.posted_id, sizeof F.posted_id, "%s", id); snprintf(F.posted, sizeof F.posted, "%s", json);
    return F.post_status ? F.post_status : 204;   // -1: a transport failure
}
static uint32_t f_now(void *c) { (void)c; return F.now; }
static int f_up_open(void *c, const char *json, char *resp, int cap) {
    (void)c; F.opens++; snprintf(F.open_json, sizeof F.open_json, "%s", json);
    snprintf(resp, (size_t)cap, "%s", F.open_resp[0] ? F.open_resp : "{\"id\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\",\"offset\":0}");
    return F.open_status ? F.open_status : 200;
}
static int f_up_chunk(void *c, const char *id, uint32_t off, const uint8_t *b, uint32_t n, char *resp, int cap) {
    (void)c; snprintf(F.chunk_id, sizeof F.chunk_id, "%s", id);
    if (F.chunks < 300) { F.chunk_offs[F.chunks] = off; F.chunk_lens[F.chunks] = n; }
    F.chunks++;
    if (F.chunk_status) { snprintf(resp, (size_t)cap, "{\"received\":%lu}", (unsigned long)F.stored_len); return F.chunk_status; }
    if (off == F.stored_len) { memcpy(F.stored + off, b, n); F.stored_len += n; }   // a retry of a stored chunk adds nothing
    else if (off > F.stored_len) { snprintf(resp, (size_t)cap, "{\"received\":%lu}", (unsigned long)F.stored_len); return 409; }
    snprintf(resp, (size_t)cap, "{\"received\":%lu}", (unsigned long)F.stored_len);
    if (F.lose_answer) { F.lose_answer = 0; return -1; }
    return 200;
}
static int f_up_close(void *c, const char *id, const char *json, char *resp, int cap) {
    (void)c; snprintf(F.close_id, sizeof F.close_id, "%s", id); F.closes++; snprintf(F.close_json, sizeof F.close_json, "%s", json);
    snprintf(resp, (size_t)cap, "%s", F.close_resp[0] ? F.close_resp : "{\"name\":\"Hello.txt\"}");
    return F.close_status ? F.close_status : 200;
}
static void f_raw_arm(void *c, as_raw_t *w) { (void)c; F.raw = (w && w->got < w->total) ? w : NULL; F.armed = w; F.arms++; }
static int f_req_fetch(void *c, char *buf, int cap) {
    (void)c; F.req_fetches++;
    if (F.req_status) return -1;
    int n = (int)strlen(F.reqs); if (n > cap) return -1;
    memcpy(buf, F.reqs, (size_t)n); F.reqs[0] = 0;          // the server marks them sent
    return n;
}
static int f_req_post(void *c, const char *rid, const char *json, int n) {
    (void)c;
    int i = F.req_posts < 12 ? F.req_posts : 11;
    snprintf(F.req_rid[i], sizeof F.req_rid[i], "%s", rid);
    memcpy(F.req_body[i], json, (size_t)n); F.req_body[i][n] = 0;
    F.req_posts++;
    return F.req_post_status ? F.req_post_status : 204;   // -1: a transport failure
}
static const as_ops_t OPS = { NULL, f_connect, f_state, f_send, f_recv, f_close, f_queue, f_chunk, f_post, f_now, f_up_open, f_up_chunk, f_up_close, f_raw_arm, f_req_fetch, f_req_post };

static amiga_send_t S;
static void reply(const char *l) { snprintf(F.in[F.in_tail], AS_LINE_MAX + 1, "%s", l); F.in_tail = (F.in_tail + 1) % 16; }
static char QBUF[AS_QUEUE_BYTES + 1];
static uint8_t CBUF[AS_UP_RING_BYTES];
static as_up_t UP;
static void fresh(void) { memset(&F, 0, sizeof F); F.now = 1000; as_init(&S, &OPS, QBUF, CBUF, &UP); }
static void run(int n) { for (int i = 0; i < n; i++) { F.budget = F.accept_max; as_tick(&S); if (as_has_work(&S)) as_step(&S); } }
static void clear_out(void) { F.out_n = 0; F.out[0] = 0; }
static const char *ID = "11111111-2222-4333-8444-555555555555";

// Connect, hello, READY: the state every file test starts from.
static void ready_with(const char *queue) {
    fresh();
    snprintf(F.queue, sizeof F.queue, "%s", queue);
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(2);                         // fetch the queue, connect
    F.sock = AS_SOCK_OPEN;
    run(1);                         // hello out
    reply("READY 1");
    run(2);                         // ready, LIST out
}

// --- tests --------------------------------------------------------------
static void off_or_no_address_does_nothing(void) {
    fresh();
    as_set_inputs(&S, false, 0xAC100AEDu, 1); run(3);
    CHECK_EQ_INT(F.connects, 0); CHECK(as_rx(&S) == '-', "rx -"); CHECK(!as_has_work(&S), "no work while off");
    as_set_inputs(&S, true, 0, 1); run(3);
    CHECK_EQ_INT(F.connects, 0);
}

static void connects_to_6800_and_says_hello(void) {
    fresh(); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(2);
    CHECK_EQ_INT(F.connects, 1); CHECK(F.ip == 0xAC100AEDu && F.port == 6800, "address and port");
    F.sock = AS_SOCK_OPEN; run(1);
    CHECK(strcmp(F.out, "WEBADF 1\n") == 0, "hello");
    reply("READY 1"); run(2);
    CHECK(as_rx(&S) == 'c', "connected");
    CHECK(strstr(F.out, "LIST 0\n") != NULL, "list forwarded");
    CHECK_EQ_INT(as_acked_version(&S), 1);
}

static void refused_then_retried_after_30s_with_nothing_waiting(void) {
    fresh(); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2);
    F.sock = AS_SOCK_REFUSED; run(1);
    CHECK(as_rx(&S) == 'r', "refused");
    F.now += 29000; run(2); CHECK_EQ_INT(F.connects, 1);
    F.now += 2000; run(2); CHECK_EQ_INT(F.connects, 2);
}

static void retried_after_5s_while_a_file_waits(void) {
    fresh(); snprintf(F.queue, sizeof F.queue, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2);
    F.sock = AS_SOCK_REFUSED; run(1);
    F.now += 5100; run(2); CHECK_EQ_INT(F.connects, 2);
}

static void connect_timeout_is_unreachable(void) {
    fresh(); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2);
    F.now += AS_CONNECT_MS + 1; run(1);
    CHECK(as_rx(&S) == 'u', "unreachable"); CHECK(F.sock == AS_SOCK_CLOSED, "closed");
}

static void no_ready_is_unreachable(void) {
    fresh(); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2);
    F.sock = AS_SOCK_OPEN; run(1);
    F.now += AS_HELLO_MS + 1; run(1);
    CHECK(as_rx(&S) == 'u', "no READY"); CHECK(F.sock == AS_SOCK_CLOSED, "closed");
}

static void one_file_end_to_end(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 40 9:Hello.txt 4:note\nLIST 1\n%s 5 9:Hello.txt\n", ID, ID);
    ready_with(q);
    memcpy(F.file, "hello", 5); F.file_len = 5;
    char want[200]; snprintf(want, sizeof want, "FILE %s 5 3610a686 40 9:Hello.txt 4:note\n", ID);
    CHECK(strstr(F.out, want) != NULL, "FILE line");
    CHECK(as_has_work(&S), "work while a file moves");
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go); clear_out();
    run(3);
    CHECK(strcmp(F.out, "hello") == 0, "bytes");
    char ok[120]; snprintf(ok, sizeof ok, "OK %s 9:Hello.txt", ID); reply(ok);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    run(3);
    CHECK_EQ_INT(F.posts, 1);
    CHECK(strcmp(F.posted_id, ID) == 0, "posted id");
    CHECK(strcmp(F.posted, "{\"ok\":true,\"savedAs\":\"Hello.txt\"}") == 0, "posted ok");
    CHECK(F.queue_fetches >= 2, "refetched after the outcome");
}

// main.c's core1 loop: a pass with no send work starts a 25 s long poll instead (bench 2026-10-18: each file of a
// 20-file folder waited one long poll, ~28 s apiece). From one file's OK to the next file's FILE line, every pass
// must be send work.
static void next_file_follows_without_a_long_poll(void) {
    static const char *ID2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 1:A 0:\nLIST 2\n%s 5 1:A\n%s 5 1:B\n", ID, ID, ID2);
    ready_with(q);
    memcpy(F.file, "hello", 5); F.file_len = 5;
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    run(3);
    char ok[120]; snprintf(ok, sizeof ok, "OK %s 1:A", ID); reply(ok);
    snprintf(F.queue, sizeof F.queue, "NEXT %s 5 3610a686 0 1:B 0:\nLIST 1\n%s 5 1:B\n", ID2, ID2);
    clear_out();
    char want[200]; snprintf(want, sizeof want, "FILE %s 5", ID2);
    int polls = 0;
    for (int i = 0; i < 12 && !strstr(F.out, want); i++) {
        F.budget = F.accept_max; as_tick(&S);
        if (as_has_work(&S)) as_step(&S); else polls++;
    }
    CHECK(strstr(F.out, want) != NULL, "the second file is offered");
    CHECK_EQ_INT(polls, 0);
}

static void err_before_go_is_posted(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 5 0 0 3:Big 0:\nLIST 1\n%s 5 3:Big\n", ID, ID);
    ready_with(q);
    char err[120]; snprintf(err, sizeof err, "ERR %s space not enough space", ID); reply(err);
    run(3);
    CHECK_EQ_INT(F.posts, 1);
    CHECK(strcmp(F.posted, "{\"ok\":false,\"code\":\"space\",\"text\":\"not enough space\"}") == 0, "posted error");
    CHECK_EQ_INT(F.chunk_fetches, 0);
}

static void big_file_in_chunks(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 40000 0 0 3:Big 0:\nLIST 1\n%s 40000 3:Big\n", ID, ID);
    ready_with(q);
    for (int i = 0; i < 40000; i++) F.file[i] = (uint8_t)i;
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go); clear_out();
    run(10);
    CHECK_EQ_INT(F.out_n, 40000);
    CHECK(memcmp(F.out, F.file, 40000) == 0, "all bytes in order");
    CHECK_EQ_INT(F.chunk_fetches, 3);
}

static void partial_send_finishes_chunk_before_next_fetch(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 20000 0 0 3:Big 0:\nLIST 1\n%s 20000 3:Big\n", ID, ID);
    ready_with(q);
    for (int i = 0; i < 20000; i++) F.file[i] = (uint8_t)(i * 7);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go); clear_out();
    F.accept_max = 1000;
    run(5);
    CHECK_EQ_INT(F.chunk_fetches, 1);       // 5 passes push at most 5000 of the first 16384
    run(40);
    CHECK_EQ_INT(F.out_n, 20000);
    CHECK_EQ_INT(F.chunk_fetches, 2);
    CHECK(memcmp(F.out, F.file, 20000) == 0, "bytes in order");
}

static void zero_length_goes_straight_to_ok(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 0 0 0 5:Empty 0:\nLIST 1\n%s 0 5:Empty\n", ID, ID);
    ready_with(q);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    char ok[120]; snprintf(ok, sizeof ok, "OK %s 5:Empty", ID); reply(ok);
    run(4);
    CHECK_EQ_INT(F.chunk_fetches, 0);
    CHECK_EQ_INT(F.posts, 1);
}

static void drop_mid_data_posts_nothing_and_resends(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 40000 0 0 3:Big 0:\nLIST 1\n%s 40000 3:Big\n", ID, ID);
    ready_with(q);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    run(2);                                  // GO, first chunk pushed
    F.sock = AS_SOCK_CLOSED;                 // Wi-Fi gone, board side closed
    run(3);
    CHECK_EQ_INT(F.posts, 0);
    CHECK(!as_has_work(&S) || F.sock != AS_SOCK_OPEN, "not sending into a closed socket");
    F.now += AS_RETRY_WAITING_MS + 10; run(2);
    F.sock = AS_SOCK_OPEN; clear_out(); run(1);
    reply("READY 1"); run(3);
    char want[160]; snprintf(want, sizeof want, "FILE %s 40000", ID);
    CHECK(strstr(F.out, want) != NULL, "the same file again");
    reply(go); F.chunk_fetches = 0; run(1);
    CHECK_EQ_INT(F.chunk_fetches, 1);
    CHECK(F.last_off == 0, "from offset 0");
}

static void receive_closed_mid_file(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 40000 0 0 3:Big 0:\nLIST 1\n%s 40000 3:Big\n", ID, ID);
    ready_with(q);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    run(2);
    F.recv_closed = true;
    run(4);
    CHECK_EQ_INT(F.posts, 0);
    CHECK(F.sock == AS_SOCK_CLOSED, "closed");
    CHECK(as_rx(&S) == 'u', "unreachable until it reconnects");
}

static void cancel_409_aborts(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 40000 0 0 3:Big 0:\nLIST 1\n%s 40000 3:Big\n", ID, ID);
    ready_with(q);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    F.chunk_error = -409;
    int fetched = F.queue_fetches;
    run(4);
    CHECK_EQ_INT(F.posts, 0);
    CHECK(F.sock == AS_SOCK_CLOSED, "closed: Receive drops its temp file");
    F.chunk_error = 0; snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    F.now += AS_RETRY_WAITING_MS + 10; run(3);
    CHECK(F.queue_fetches > fetched, "queue refetched");
}

static void failed_post_is_retried_and_409_counts_as_landed(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 0 0 0 1:x 0:\nLIST 1\n%s 0 1:x\n", ID, ID);
    ready_with(q);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    char ok[120]; snprintf(ok, sizeof ok, "OK %s 1:x", ID); reply(ok);
    F.post_status = 503;
    run(3);
    CHECK(F.posts >= 1, "tried");
    CHECK(!as_has_work(&S), "backing off: the board long-polls meanwhile");
    F.post_status = 409; int before = F.posts;
    F.now += AS_BACKOFF_MIN_MS + 1;
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");   // the server's queue once the outcome landed
    run(3);
    CHECK(F.posts == before + 1, "posted again once");
    CHECK(!as_has_work(&S), "done");
}

static void pings_when_idle_and_drops_without_pong(void) {
    ready_with("NEXT -\nLIST 0\n");
    clear_out();
    F.now += AS_PING_MS + 1; run(1);
    CHECK(strcmp(F.out, "PING\n") == 0, "ping");
    reply("PONG"); run(1);
    F.now += AS_PONG_MS + 1; run(1);
    CHECK(F.sock == AS_SOCK_OPEN, "still open after PONG");
    clear_out(); F.now += AS_PING_MS + 1; run(1);
    CHECK(strcmp(F.out, "PING\n") == 0, "second ping");
    F.now += AS_PONG_MS + 1; run(1);
    CHECK(F.sock == AS_SOCK_CLOSED, "no PONG: closed");
    CHECK(as_rx(&S) == 'u', "unreachable");
}

static void new_queue_version_refetches_and_forwards_list(void) {
    ready_with("NEXT -\nLIST 0\n");
    CHECK(!as_has_work(&S), "idle");
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    clear_out();
    as_set_inputs(&S, true, 0xAC100AEDu, 2);
    CHECK(as_has_work(&S), "fetch owed");
    run(2);
    CHECK_EQ_INT(as_acked_version(&S), 2);
    CHECK(strstr(F.out, "LIST 0\n") != NULL, "list forwarded again");
}

static void json_escapes_latin1(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 0 0 0 8:Caf\xe9.txt 0:\nLIST 1\n%s 0 8:Caf\xe9.txt\n", ID, ID);
    ready_with(q);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    char ok[120]; snprintf(ok, sizeof ok, "OK %s 8:Caf\xe9.txt", ID); reply(ok);
    run(4);
    CHECK(strcmp(F.posted, "{\"ok\":true,\"savedAs\":\"Caf\\u00e9.txt\"}") == 0, "escaped");
    char out[40];
    CHECK_EQ_INT(as_json_escape(out, sizeof out, "a\"b\\c", 5), 7);
    CHECK(strcmp(out, "a\\\"b\\\\c") == 0, "quote and backslash");
    CHECK_EQ_INT(as_json_escape(out, 4, "abcdef", 6), 3);              // cut to fit, never refused
    CHECK(strcmp(out, "abc") == 0, "cut");
    CHECK_EQ_INT(as_json_escape(out, 8, "ab\xe9\xe9", 4), 2);          // never half an escape
    CHECK(strcmp(out, "ab") == 0, "whole escapes only");
}

static void without_buffers_it_never_runs(void) {
    memset(&F, 0, sizeof F); F.now = 1000; as_init(&S, &OPS, NULL, NULL, NULL);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(3);
    CHECK(!as_has_work(&S), "no work"); CHECK_EQ_INT(F.connects, 0); CHECK_EQ_INT(F.queue_fetches, 0);
}

static void turning_network_off_closes(void) {
    ready_with("NEXT -\nLIST 0\n");
    as_set_inputs(&S, false, 0, 1); run(1);
    CHECK(F.sock == AS_SOCK_CLOSED, "closed"); CHECK(as_rx(&S) == '-', "off");
}


// Review I3: Receive takes lines of 640; the longest legal FILE line (36-char id, 4 MB, ffffffff, a 255-byte path,
// a 79-char comment) is 398 bytes and must go out whole.
static void longest_legal_next_line_goes_out_whole(void) {
    char path[256], comment[80], q[1200];
    memset(path, 'p', 255); path[255] = 0; for (int i = 30; i < 255; i += 31) path[i] = '/';
    memset(comment, 'c', 79); comment[79] = 0;
    snprintf(q, sizeof q, "NEXT %s 4194304 ffffffff ffffffff 255:%s 79:%s\nLIST 1\n%s 4194304 255:%s\n", ID, path, comment, ID, path);
    ready_with(q);
    char want[700]; snprintf(want, sizeof want, "FILE %s 4194304 ffffffff ffffffff 255:%s 79:%s\n", ID, path, comment);
    CHECK(strstr(F.out, want) != NULL, "the whole FILE line");
}

// Review I3: a NEXT line the board cannot read is reported as a failure, never refetched in a loop.
static void unreadable_next_is_failed_not_looped(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s notanumber\nLIST 1\n%s 1 1:x\n", ID, ID);
    ready_with(q);
    run(5);
    CHECK(F.posts >= 1, "posted");
    CHECK(strstr(F.posted, "\"ok\":false") != NULL && strstr(F.posted, "\"code\":\"name\"") != NULL, "as a name failure");
    CHECK(F.queue_fetches <= 3, "no fetch loop");
}

// Review I4: failed HTTPS calls back off (1 s doubling to 30 s), and meanwhile there is no work: the board long-polls.
static void failed_fetch_backs_off(void) {
    fresh(); F.queue_status = -1;
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(20);
    CHECK_EQ_INT(F.queue_fetches, 1);
    CHECK(!as_has_work(&S), "no work during the backoff");
    F.now += 1001; run(1); CHECK_EQ_INT(F.queue_fetches, 2);
    F.now += 1001; run(1); CHECK_EQ_INT(F.queue_fetches, 2);     // now 2 s
    F.now += 1001; run(1); CHECK_EQ_INT(F.queue_fetches, 3);
    F.queue_status = 0; snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    F.now += 5000; run(2);
    CHECK_EQ_INT(as_acked_version(&S), 1);
}

static void failed_post_backs_off_and_400_is_final(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 0 0 0 1:x 0:\nLIST 1\n%s 0 1:x\n", ID, ID);
    ready_with(q);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    char ok[120]; snprintf(ok, sizeof ok, "OK %s 1:x", ID); reply(ok);
    F.post_status = -1;
    run(20);
    CHECK_EQ_INT(F.posts, 1);                                    // one try, then the backoff
    F.post_status = 400; F.now += 1001;
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    run(3);
    CHECK_EQ_INT(F.posts, 2);
    run(5);
    CHECK_EQ_INT(F.posts, 2);                                    // a 400 is final: not posted again
    CHECK(!as_has_work(&S), "done");
}

static void long_latin1_saved_name_is_cut_not_emptied(void) {
    char name[256], q[900], ok[400];
    memset(name, 0xe9, 200); name[200] = 0;
    snprintf(q, sizeof q, "NEXT %s 0 0 0 200:%s 0:\nLIST 1\n%s 0 200:%s\n", ID, name, ID, name);
    ready_with(q);
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go);
    snprintf(ok, sizeof ok, "OK %s 200:%s", ID, name); reply(ok);
    run(4);
    CHECK(strncmp(F.posted, "{\"ok\":true,\"savedAs\":\"\\u00e9", 28) == 0, "a non-empty, valid savedAs");
    CHECK(F.posted[strlen(F.posted) - 1] == '}', "closed JSON");
}

// What amiga_tcp.c's receive callback does: the armed raw section first (as_raw_feed), the rest as lines.
static void amiga_sends(const void *data, int n) {
    const uint8_t *b = data; int i = 0;
    if (F.raw) {
        int k = as_raw_feed(F.raw, b, n);
        if (k < 0) { F.recv_closed = true; return; }
        i = k;
        if (F.raw->got == F.raw->total) F.raw = NULL;
    }
    for (; i < n; i++) {
        if (b[i] == '\n') { F.partial[F.partial_n] = 0; reply(F.partial); F.partial_n = 0; }
        else if (F.partial_n < AS_LINE_MAX) F.partial[F.partial_n++] = (char)b[i];
    }
}
static const char *KEY = "ab12cd34ef56ab12cd34ef56ab12cd34";
// Connected to a Receive 2 that trusts us: the state every upload test starts from.
static void ready2_with(const char *queue) {
    fresh();
    as_set_key(&S, KEY);
    snprintf(F.queue, sizeof F.queue, "%s", queue);
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 2"); run(2);
    clear_out();
}
static void ready2(void) { ready2_with("NEXT -\nLIST 0\n"); }
static unsigned long crc32_of(const uint8_t *p, size_t n) {
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) { c ^= p[i]; for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (uint32_t)-(int32_t)(c & 1u)); }
    return (unsigned long)~c;
}
static void end_line(const char *tag, const uint8_t *p, size_t n) {
    char e[40]; int k = snprintf(e, sizeof e, "END %s %lx\n", tag, crc32_of(p, n)); amiga_sends(e, k);
}
static const char *PUT5 = "PUT 1 5 1.2.3 0 9:Hello.txt 0:";
// --- NET: volumes (spec 2026-10-30 section 3, fw 1.22.0) ---
static as_req_t RQ;
// Connected to Transfer 2.3 (READY 3 <browse>), the queue empty, nothing fetched yet.
static void ready3(int browse) {
    fresh();
    as_set_key(&S, KEY);
    as_set_req(&S, &RQ);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply(browse ? "READY 3 1" : "READY 3 0"); run(2);
    clear_out();
}
// The poll said req.v = v, and GET /api/device/req will return these lines.
static void wake(uint32_t v, const char *lines) { snprintf(F.reqs, sizeof F.reqs, "%s", lines); as_set_req_version(&S, v); }

static void the_hello_is_protocol_3_with_requests(void) {
    fresh(); as_set_key(&S, KEY); as_set_req(&S, &RQ);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    char want[64]; snprintf(want, sizeof want, "WEBADF 3 %s\n", KEY);
    CHECK(strcmp(F.out, want) == 0, F.out);
    CHECK_EQ_INT(as_rx_proto(&S), 0);
    reply("READY 3 1"); run(2);
    CHECK_EQ_INT(as_rx_proto(&S), 3); CHECK(as_browse(&S), "browsing on");
    CHECK(as_req_capable(&S), "capable");
    ready3(0);
    CHECK_EQ_INT(as_rx_proto(&S), 3); CHECK(!as_browse(&S), "browsing off");
}

static void without_requests_the_hello_stays_2(void) {
    ready2();
    CHECK(!as_req_capable(&S), "not capable");
    CHECK_EQ_INT(as_rx_proto(&S), 2); CHECK(!as_browse(&S), "no browse");
    fresh(); as_set_req(&S, &RQ);                       // no key, so no uploads: requests stay off too
    as_set_key(&S, "not-hex");
    CHECK(as_req_capable(&S), "state given");
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    CHECK(strcmp(F.out, "WEBADF 1\n") == 0, F.out);
}

static void a_ready_3_to_a_protocol_2_hello_counts_as_1(void) {
    fresh(); as_set_key(&S, KEY);                       // uploads, no requests: WEBADF 2
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 3 1"); run(2);
    CHECK_EQ_INT(as_rx_proto(&S), 1);                   // not READY 2 either: read as Receive 1, as 1.21 does
}

static void transfer_2_2_answers_ready_2_and_requests_get_old(void) {
    fresh(); as_set_key(&S, KEY); as_set_req(&S, &RQ);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 2"); run(2);
    CHECK_EQ_INT(as_rx_proto(&S), 2);
    clear_out();
    wake(1, "VOLS a\n"); run(4);
    CHECK(strstr(F.out, "VOLS") == NULL, "never sent to a 2.2");
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ERR a old 31:Transfer 2.3 or newer is needed\"],\"last\":true}") == 0, F.req_body[0]);
    CHECK(!RQ.active, "done");
}

static void vols_is_relayed_and_answered_in_one_piece(void) {
    ready3(1);
    wake(1, "VOLS r1\n"); run(3);
    CHECK_EQ_INT(F.req_fetches, 1);
    CHECK_EQ_INT(as_req_acked(&S), 1);
    CHECK(strcmp(F.out, "VOLS r1\n") == 0, F.out);
    CHECK(as_has_work(&S), "work while an answer is awaited (no long poll)");
    reply("VOL r1 9:Workbench 4:DH0: 1000 500 17000.0.0");
    reply("DONE r1 1");
    run(3);
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_rid[0], "r1") == 0, F.req_rid[0]);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"VOL r1 9:Workbench 4:DH0: 1000 500 17000.0.0\",\"DONE r1 1\"],\"last\":true}") == 0, F.req_body[0]);
    CHECK(!RQ.active && !as_has_work(&S), "idle after");
}

static void the_ack_is_the_v_seen_before_the_fetch(void) {
    ready3(1);
    wake(5, "VOLS a\nVOLS b\n"); run(2);
    CHECK_EQ_INT(as_req_acked(&S), 5);
    as_set_req_version(&S, 6);                          // the server bumped again (requests remain): not fetched yet
    run(2);
    CHECK_EQ_INT(F.req_fetches, 1);                     // the board still holds b: no fetch while it does
    CHECK_EQ_INT(as_req_acked(&S), 5);
    reply("DONE a 0"); run(3);
    CHECK(strstr(F.out, "VOLS b\n") != NULL, "b next");
    reply("DONE b 0"); run(4);
    CHECK_EQ_INT(F.req_fetches, 2);                     // now empty: fetched for 6
    CHECK_EQ_INT(as_req_acked(&S), 6);
}

static void requests_go_one_at_a_time_in_order(void) {
    ready3(1);
    wake(1, "VOLS a\nDIR b 5:Work:\n"); run(3);
    CHECK(strcmp(F.out, "VOLS a\n") == 0, F.out);
    run(3);
    CHECK(strstr(F.out, "DIR") == NULL, "b waits for a's answer");
    reply("DONE a 0"); run(3);
    CHECK(strstr(F.out, "DIR b 5:Work:\n") != NULL, F.out);
}

// Review Focus 1.
static void a_drawer_of_latin1_names_arrives_in_pieces_under_32k(void) {
    char name[31], com[80], line[300];
    memset(name, 0xe9, 30); name[30] = 0; memset(com, 0xe9, 79); com[79] = 0;
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    const int N = 100;
    for (int i = 0; i < N; ) {
        for (int k = 0; k < 10 && i < N; k++, i++) {
            snprintf(line, sizeof line, "ENT d f %d 0 1.0.0 30:%s 79:%s", i, name, com);
            reply(line);
        }
        run(2);
    }
    reply("DONE d 100"); run(6);
    CHECK(F.req_posts >= 3, "several pieces");
    int ents = 0;
    for (int p = 0; p < F.req_posts && p < 12; p++) {
        char head[32]; snprintf(head, sizeof head, "{\"piece\":%d,\"lines\":[", p);
        CHECK(strncmp(F.req_body[p], head, strlen(head)) == 0, F.req_body[p]);
        CHECK(strlen(F.req_body[p]) <= AR_BODY_BYTES, "inside 32 KB");
        const bool last = p == F.req_posts - 1;
        CHECK(strcmp(F.req_body[p] + strlen(F.req_body[p]) - (last ? 14 : 15), last ? "],\"last\":true}" : "],\"last\":false}") == 0, "closed");
        for (const char *q = F.req_body[p]; (q = strstr(q, "\"ENT d f ")) != NULL; q++) ents++;
    }
    CHECK_EQ_INT(ents, N);
    CHECK(strstr(F.req_body[F.req_posts - 1], "\"DONE d 100\"") != NULL, "DONE in the last piece");
    for (int p = 0, want = 0; p < F.req_posts; p++) {      // in order: each piece's first ENT continues the count
        char first[40]; snprintf(first, sizeof first, "\"ENT d f %d 0 ", want);
        if (strstr(F.req_body[p], "\"ENT d f ")) CHECK(strstr(F.req_body[p], first) == strstr(F.req_body[p], "\"ENT d f "), first);
        for (const char *q = F.req_body[p]; (q = strstr(q, "\"ENT d f ")) != NULL; q++) want++;
    }
}

static void a_piece_closes_at_400_lines(void) {
    char line[64];
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    for (int i = 0; i < 450; ) {
        for (int k = 0; k < 10 && i < 450; k++, i++) { snprintf(line, sizeof line, "ENT d f 1 0 1.0.0 3:%03d 0:", i); reply(line); }
        run(2);
    }
    reply("DONE d 450"); run(4);
    CHECK_EQ_INT(F.req_posts, 2);
    CHECK(strstr(F.req_body[0], "3:399") != NULL && strstr(F.req_body[0], "3:400") == NULL, "400 lines in piece 0");
    CHECK(strstr(F.req_body[1], "{\"piece\":1,") == F.req_body[1] && strstr(F.req_body[1], "3:400") != NULL, "the rest in piece 1");
}

static void lines_wait_in_the_socket_while_a_piece_cannot_post(void) {
    char line[64];
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    F.req_post_status = -1;                             // the server is unreachable
    for (int i = 0; i < 400; ) {
        for (int k = 0; k < 10 && i < 400; k++, i++) { snprintf(line, sizeof line, "ENT d f 1 0 1.0.0 3:%03d 0:", i); reply(line); }
        run(2);
    }
    reply("ENT d f 1 0 1.0.0 3:400 0:"); run(3);
    CHECK(F.in_head != F.in_tail, "line 401 still in the socket");
    F.req_post_status = 0; F.now += 2000; run(3);
    CHECK(F.in_head == F.in_tail, "read once the piece posted");
    reply("DONE d 401"); run(3);
    CHECK(strstr(F.req_body[F.req_posts - 1], "3:400") != NULL, "line 401 kept");
}

static void norx_when_transfer_is_not_connected(void) {
    fresh(); as_set_key(&S, KEY); as_set_req(&S, &RQ);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2);
    F.sock = AS_SOCK_REFUSED; run(1);                   // Transfer not running: 30 s to the next try
    wake(1, "VOLS a\n"); run(3);
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ERR a norx 36:Transfer is not running on the Amiga\"],\"last\":true}") == 0, F.req_body[0]);
}

// Review Focus 3 (plan ruling F8).
static void a_close_at_protocol_3_reconnects_in_5s_and_reports_browse(void) {
    ready3(1);
    CHECK(as_browse(&S), "on");
    F.recv_closed = true; run(1);                       // Transfer's switch changed: it closed the idle connection
    CHECK_EQ_INT(as_rx_proto(&S), 0); CHECK(!as_browse(&S), "unknown while closed");
    wake(1, "VOLS a\n"); run(3);
    CHECK_EQ_INT(F.req_posts, 0);                       // a reconnect is due in 5 s: the request waits for it
    F.recv_closed = false; F.now += AS_RETRY_WAITING_MS + 100; run(2);
    CHECK_EQ_INT(F.connects, 2);
    F.sock = AS_SOCK_OPEN; run(1); reply("READY 3 0"); run(3);
    CHECK(!as_browse(&S), "the new flag");
    CHECK(strstr(F.out, "VOLS a\n") != NULL, "relayed after the reconnect");
}

static void silent_transfer_mid_answer_is_timeout_and_drops(void) {
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    reply("ENT d f 1 0 1.0.0 1:a 0:"); run(2);
    F.now += AS_REQ_SILENT_MS - 1; run(2);
    CHECK_EQ_INT(F.req_posts, 0); CHECK(F.sock == AS_SOCK_OPEN, "not yet");
    F.now += 2; run(3);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped (plan ruling F4)");
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ENT d f 1 0 1.0.0 1:a 0:\",\"ERR d timeout 26:Transfer stopped answering\"],\"last\":true}") == 0, F.req_body[0]);
}

// Review Focus 4.
static void a_dropped_connection_mid_answer_ends_norx_lost(void) {
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    reply("ENT d f 1 0 1.0.0 1:a 0:"); run(2);
    F.recv_closed = true; run(3);
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_body[0], "{\"piece\":0,\"lines\":[\"ENT d f 1 0 1.0.0 1:a 0:\",\"ERR d norx 35:The connection to Transfer was lost\"],\"last\":true}") == 0, F.req_body[0]);
}

static void a_request_waits_behind_a_moving_download(void) {
    char q[600];
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    ready3(1);
    snprintf(F.queue, sizeof F.queue, "%s", q); as_set_inputs(&S, true, 0xAC100AEDu, 2); run(3);
    memcpy(F.file, "hello", 5); F.file_len = 5;
    char want[120]; snprintf(want, sizeof want, "FILE %s", ID);
    CHECK(strstr(F.out, want) != NULL, "the download started");
    wake(1, "VOLS a\n"); run(3);
    CHECK_EQ_INT(F.req_fetches, 0);                     // not even fetched while a file moves
    char go[80]; snprintf(go, sizeof go, "GO %s", ID); reply(go); run(3);
    char ok[120]; snprintf(ok, sizeof ok, "OK %s 5:Hello", ID); reply(ok);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    run(6);
    CHECK(strstr(F.out, "VOLS a\n") != NULL, "after the file");
}

static void a_request_goes_before_a_queued_download(void) {
    char q[600];
    ready3(1);
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    snprintf(F.queue, sizeof F.queue, "%s", q);
    as_set_inputs(&S, true, 0xAC100AEDu, 2);
    wake(1, "VOLS a\n");
    run(4);
    CHECK(strstr(F.out, "VOLS a\n") != NULL, "the request went");
    char want[120]; snprintf(want, sizeof want, "FILE %s", ID);
    CHECK(strstr(F.out, want) == NULL, "the download waits for the answer");
    reply("DONE a 0"); run(4);
    CHECK(strstr(F.out, want) != NULL, "then the download");
}

// Review Focus 2 (plan ruling F3).
static void a_put_that_crosses_a_request_goes_first(void) {
    ready3(1);
    wake(1, "VOLS a\n"); run(3);
    CHECK(strcmp(F.out, "VOLS a\n") == 0, F.out);
    reply(PUT5); run(2);                                 // Transfer sent its PUT before it read VOLS
    CHECK_EQ_INT(F.opens, 1);
    CHECK(strstr(F.out, "TAKE 1 0 5\n") != NULL, "the upload goes while the request waits");
    F.now += AS_REQ_SILENT_MS + 5000; run(2);           // no timeout while the upload moves
    CHECK(F.sock == AS_SOCK_OPEN && F.req_posts == 0, "still open");
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK_EQ_INT(F.closes, 1);
    reply("DONE a 0"); run(3);                          // then Transfer answers the request
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strstr(F.req_body[0], "\"DONE a 0\"") != NULL, F.req_body[0]);
}

static void browse_off_still_relays_and_transfer_says_off(void) {   /* plan ruling F11 */
    ready3(0);
    wake(1, "VOLS a\n"); run(3);
    CHECK(strcmp(F.out, "VOLS a\n") == 0, F.out);
    reply("ERR a off 34:Browsing is off in Transfer (A500)"); run(3);
    CHECK(strstr(F.req_body[0], "\"ERR a off 34:") != NULL, F.req_body[0]);
}

static void a_failing_fetch_backs_off(void) {
    ready3(1);
    F.req_status = 1; wake(1, "VOLS a\n"); run(2);
    CHECK_EQ_INT(F.req_fetches, 1);
    CHECK_EQ_INT(as_req_acked(&S), 0);                  // not acked: fetched again
    run(3);
    CHECK_EQ_INT(F.req_fetches, 1);                     // backing off
    F.req_status = 0; F.now += 1100; run(3);
    CHECK_EQ_INT(F.req_fetches, 2); CHECK_EQ_INT(as_req_acked(&S), 1);
}
// Fix round 1, finding 1: after an upload a queued download used to starve a crossing PUT (300 s, then NO offline).
static void a_put_that_crosses_a_request_after_an_upload_goes_first(void) {
    char q[600];
    ready3(1);
    reply(PUT5); run(1); amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK_EQ_INT(F.closes, 1);                          // one complete upload: up_last is set
    clear_out();
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    snprintf(F.queue, sizeof F.queue, "%s", q);
    as_set_inputs(&S, true, 0xAC100AEDu, 2);
    wake(1, "VOLS a\n"); run(4);
    CHECK(strstr(F.out, "VOLS a\n") != NULL, "the request went");
    const int opens = F.opens;
    reply("PUT 2 5 1.2.3 0 9:Hello.txt 0:"); run(4);    // Transfer sent it before it read VOLS
    CHECK(F.opens == opens + 1, "the crossing PUT opened");
    CHECK(strstr(F.out, "TAKE 2 ") != NULL, "and was told to go on");
}

// Fix round 1, finding 2: lines held for an owed piece hold the PONG too, so no PING may go out meanwhile.
static void no_ping_while_lines_wait_for_a_piece(void) {
    char line[64];
    ready3(1);
    wake(1, "DIR d 5:Work:\n"); run(3);
    F.req_post_status = -1;
    for (int i = 0; i < 400; ) {
        for (int k = 0; k < 10 && i < 400; k++, i++) { snprintf(line, sizeof line, "ENT d f 1 0 1.0.0 3:%03d 0:", i); reply(line); }
        run(2);
    }
    reply("ENT d f 1 0 1.0.0 3:400 0:"); run(3);
    CHECK(F.in_head != F.in_tail, "line 401 held in the socket");
    clear_out();
    for (int i = 0; i < 12; i++) {
        F.now += (AS_PING_MS + AS_PONG_MS) / 6; run(2);
    }
    CHECK(F.sock == AS_SOCK_OPEN, "the link stays up");
    CHECK(strstr(F.out, "PING") == NULL, "no PING while lines are held");
    CHECK(F.in_head != F.in_tail, "still held");
    F.req_post_status = 0; F.now += 40000; run(3);
    CHECK(F.in_head == F.in_tail, "read once the piece posted");
}

// Fix round 1, finding 3: a 4xx the retry cannot cure is a refusal, like done_owed's.
static void a_403_piece_is_refused_not_retried(void) {
    ready3(1);
    F.req_post_status = 403;
    wake(1, "VOLS a\nVOLS b\n"); run(3);
    reply("DONE a 0"); run(4);
    CHECK_EQ_INT(F.req_posts, 1);
    CHECK(strcmp(F.req_rid[0], "a") == 0, F.req_rid[0]);
    F.req_post_status = 0;
    run(3);
    CHECK_EQ_INT(F.req_posts, 1);                       // never retried
    CHECK(strstr(F.out, "VOLS b\n") != NULL, "the next request goes");
    reply("DONE b 0"); run(3);
    CHECK_EQ_INT(F.req_posts, 2);
    CHECK(strcmp(F.req_rid[1], "b") == 0, F.req_rid[1]);
}

static const char *UID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";   // the fake server's upload id
// Window values come from the constant (plan ruling PF3: Task 11 may change it). BIGN is always past the window.
#define CH AS_CHUNK_BYTES
#define W ((uint32_t)AS_UP_RING_BYTES)
#define WC ((int)AS_UP_WINDOW_CHUNKS)
#define BIGN (W + 7232u)
static uint32_t umin(uint32_t a, uint32_t b) { return a < b ? a : b; }
static uint8_t BIG[200000];
typedef char big_fits[(BIGN <= sizeof BIG && BIGN <= sizeof F.stored) ? 1 : -1];
static void fill_big(void) { for (unsigned i = 0; i < sizeof BIG; i++) BIG[i] = (uint8_t)(i * 13 + 5); }
static void put_big(void) { char l[64]; snprintf(l, sizeof l, "PUT 1 %lu 1.2.3 0 3:Big 0:", (unsigned long)BIGN); reply(l); }
// --- protocol 2 (spec 2026-10-18 §3) ---
static void the_hello_carries_the_key(void) {
    fresh(); as_set_key(&S, KEY); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    char want[64]; snprintf(want, sizeof want, "WEBADF 2 %s\n", KEY);
    CHECK(strcmp(F.out, want) == 0, "WEBADF 2 <key>");
}
static void without_a_key_or_state_the_hello_stays_protocol_1(void) {
    fresh(); as_set_key(&S, "not-hex"); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    CHECK(strcmp(F.out, "WEBADF 1\n") == 0, "a bad key: protocol 1");
    memset(&F, 0, sizeof F); F.now = 1000; as_init(&S, &OPS, QBUF, CBUF, NULL); as_set_key(&S, KEY);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    CHECK(strcmp(F.out, "WEBADF 1\n") == 0, "no upload state: protocol 1");
}
static void raw_bytes_land_in_the_ring_and_the_rest_are_lines(void) {
    static uint8_t ring[AS_UP_RING_BYTES];
    as_raw_t w = { ring, 10, 10, 0, false };
    CHECK_EQ_INT(as_raw_feed(&w, (const uint8_t *)"0123456789END 1 0\n", 18), 10);
    CHECK(memcmp(ring, "0123456789", 10) == 0, "ten raw bytes");
    CHECK_EQ_INT(w.got, 10);
    CHECK_EQ_INT(as_raw_feed(&w, (const uint8_t *)"x", 1), 0);    // the section is over: lines
}
static void a_byte_past_the_credit_breaks_it(void) {
    static uint8_t ring[AS_UP_RING_BYTES];
    as_raw_t w = { ring, 100, 5, 0, false };
    CHECK_EQ_INT(as_raw_feed(&w, (const uint8_t *)"123456", 6), -1);
    CHECK(w.broken, "broken"); CHECK_EQ_INT(w.got, 0);
}
static void the_ring_wraps_at_its_size(void) {
    static uint8_t ring[AS_UP_RING_BYTES];
    static uint8_t big[AS_UP_RING_BYTES + 10];
    for (unsigned i = 0; i < sizeof big; i++) big[i] = (uint8_t)i;
    as_raw_t w = { ring, AS_UP_RING_BYTES + 10, AS_UP_RING_BYTES + 10, AS_UP_RING_BYTES - 4, false };
    CHECK_EQ_INT(as_raw_feed(&w, big + AS_UP_RING_BYTES - 4, 14), 14);
    CHECK(memcmp(ring + AS_UP_RING_BYTES - 4, big + AS_UP_RING_BYTES - 4, 4) == 0, "the end of the ring");
    CHECK(memcmp(ring, big + AS_UP_RING_BYTES, 10) == 0, "then its start");
}
static void put_parses_and_json_escapes_latin1(void) {   /* Review Focus 3 */
    as_put_t p; char json[AS_UP_JSON_MAX];
    CHECK(as_put_parse("PUT 7 5 1.2.3 40 8:Caf\xe9.txt 4:note", &p), "parsed");
    CHECK(strcmp(p.tag, "7") == 0 && p.size == 5 && p.prot == 0x40 && strcmp(p.date, "1.2.3") == 0, "fields");
    CHECK(p.path_n == 8 && memcmp(p.path, "Caf\xe9.txt", 8) == 0 && p.comment_n == 4, "path and comment");
    CHECK(as_put_json(&p, NULL, json, sizeof json) > 0, "json");
    CHECK(strcmp(json, "{\"size\":5,\"date\":\"1.2.3\",\"protection\":64,\"path\":\"Caf\\u00e9.txt\",\"comment\":\"note\"}") == 0, json);
    CHECK(!as_put_parse("PUT x 5 1.2.3 0 1:a 0:", &p), "a tag is digits");
    CHECK(!as_put_parse("PUT 1 5 1.2 0 1:a 0:", &p), "a date has three parts");
    CHECK(!as_put_parse("PUT 1 5 1.2.3 0 9:a 0:", &p), "a length past the line");
    CHECK(!as_put_parse("PUT 1 5 1.2.3 0 0: 0:", &p), "an empty path");
    CHECK(!as_put_parse("PUT 1 99999999999 1.2.3 0 1:a 0:", &p), "a size over 32 bits");
}
static void the_worst_put_json_fits(void) {
    char line[700], name[256], json[AS_UP_JSON_MAX]; as_put_t p;
    memset(name, 0xe9, 255); name[255] = 0;
    char com[80]; memset(com, 0xe9, 79); com[79] = 0;            // every byte an escape, the date at its 23 chars
    snprintf(line, sizeof line, "PUT 999999999 4294967295 99999999.99999999.99999 ffffffff 255:%s 79:%s", name, com);
    CHECK(as_put_parse(line, &p), "the longest PUT the parser takes");
    CHECK_EQ_INT((int)strlen(p.date), 23);
    int n = as_put_json(&p, NULL, json, sizeof json);
    CHECK(n > 0 && n < AS_UP_JSON_MAX && (int)strlen(json) == n, "its JSON fits AS_UP_JSON_MAX, never cut");
    CHECK(n > 255 * 6 + 79 * 6, "the whole path and comment, escaped");
}
static void utf8_comes_back_as_latin1(void) {
    char out[32];
    CHECK_EQ_INT(as_utf8_to_latin1("Caf\xc3\xa9.txt", out, sizeof out), 8);
    CHECK(strcmp(out, "Caf\xe9.txt") == 0, "é");
    as_utf8_to_latin1("a\xe2\x82\xac" "b", out, sizeof out);
    CHECK(strcmp(out, "a?b") == 0, "beyond Latin-1: ?");
}

// --- protocol 2 uploads (spec 2026-10-18 §3, §5; plan Task 10) ---
static void ready_2_lets_a_put_in_and_ready_1_does_not(void) {
    ready2(); reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 1);
    fresh(); as_set_key(&S, KEY); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 1"); run(2);
    reply(PUT5); run(3);
    CHECK_EQ_INT(F.opens, 0);                     // Receive 1 never PUTs; a stray PUT is ignored
}
// Task 9 review carry: READY 2 counts only when our hello was protocol 2.
static void a_ready_2_to_a_protocol_1_hello_lets_no_put_in(void) {
    fresh(); snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");   // upload state, but no key: WEBADF 1
    as_set_inputs(&S, true, 0xAC100AEDu, 1); run(2); F.sock = AS_SOCK_OPEN; run(1);
    CHECK(strcmp(F.out, "WEBADF 1\n") == 0, F.out);
    reply("READY 2"); run(2);
    reply(PUT5); run(3);
    CHECK_EQ_INT(F.opens, 0);
    CHECK(F.sock == AS_SOCK_OPEN, "ignored, as from Receive 1");
}
static void a_small_upload_end_to_end(void) {
    ready2(); reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 1);
    CHECK(strstr(F.open_json, "\"size\":5") && strstr(F.open_json, "\"path\":\"Hello.txt\""), F.open_json);
    CHECK(strcmp(F.out, "TAKE 1 0 5\n") == 0, F.out);
    CHECK(as_has_work(&S), "work while an upload is open");
    clear_out();
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5);
    run(4);
    CHECK_EQ_INT(F.chunks, 1); CHECK(F.chunk_offs[0] == 0 && F.chunk_lens[0] == 5, "one chunk");
    CHECK(strcmp(F.chunk_id, UID) == 0 && strcmp(F.close_id, UID) == 0, "the server's id");
    CHECK(memcmp(F.stored, "hello", 5) == 0, "the bytes");
    CHECK(strstr(F.out, "MORE 1 5 5\n") != NULL, F.out);                 // PF16: the stored progress
    CHECK_EQ_INT(F.closes, 1); CHECK(strcmp(F.close_json, "{\"crc32\":907060870}") == 0, F.close_json);
    CHECK(strstr(F.out, "DONE 1 9:Hello.txt\n") != NULL, F.out);
    CHECK(!as_has_work(&S), "idle after");
}
static void a_big_upload_moves_in_16k_chunks_and_the_credit_follows(void) {
    char want[80];
    fill_big(); ready2();
    put_big(); run(1);
    snprintf(want, sizeof want, "TAKE 1 0 %lu\n", (unsigned long)W);
    CHECK(strcmp(F.out, want) == 0, F.out);
    clear_out();
    amiga_sends(BIG, (int)W); run(WC + 1);
    CHECK_EQ_INT(F.chunks, WC);
    // MORE <tag> <credit> <stored> after each chunk (PF16): the stored field advances chunk by chunk.
    const char *at = F.out;
    for (int k = 1; k <= WC; k++) {
        snprintf(want, sizeof want, "MORE 1 %lu %lu\n", (unsigned long)umin((uint32_t)k * CH + W, BIGN), (unsigned long)((uint32_t)k * CH));
        const char *m = strstr(at, want);
        CHECK(m != NULL, want);
        if (m) at = m + 1;
    }
    amiga_sends(BIG + W, (int)(BIGN - W)); end_line("1", BIG, BIGN);
    run(4);
    CHECK_EQ_INT(F.chunks, WC + 1); CHECK(F.chunk_offs[WC] == W && F.chunk_lens[WC] == 7232, "the last chunk");
    snprintf(want, sizeof want, "MORE 1 %lu %lu\n", (unsigned long)BIGN, (unsigned long)BIGN);
    CHECK(strstr(F.out, want) != NULL, "all of it stored");
    CHECK(memcmp(F.stored, BIG, BIGN) == 0, "every byte, in order");
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void bytes_past_the_credit_drop_the_connection(void) {
    fill_big(); ready2(); put_big(); run(1);
    amiga_sends(BIG, (int)W + 1); run(2);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped");
    CHECK(F.raw == NULL && F.arms >= 2, "the raw section disarmed");
}
static void the_servers_offset_resumes_the_file(void) {
    char want[80];
    fill_big(); ready2();
    memcpy(F.stored, BIG, CH); F.stored_len = CH;
    snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"%s\",\"offset\":%u}", UID, (unsigned)CH);
    put_big(); run(1);
    snprintf(want, sizeof want, "TAKE 1 %u %lu\n", (unsigned)CH, (unsigned long)umin(CH + W, BIGN));
    CHECK(strcmp(F.out, want) == 0, F.out);
    amiga_sends(BIG + CH, (int)(BIGN - CH)); end_line("1", BIG, BIGN);
    const int n = (int)((BIGN - CH + CH - 1) / CH);
    run(n + 4);
    CHECK_EQ_INT(F.chunks, n);
    for (int i = 0; i < n; i++) CHECK(F.chunk_offs[i] == CH + (uint32_t)i * CH, "from the offset");
    CHECK(memcmp(F.stored, BIG, BIGN) == 0, "whole");
}
static void resume_at_size_goes_straight_to_close(void) {       /* Review Focus 1 */
    ready2(); memcpy(F.stored, "hello", 5); F.stored_len = 5;
    snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"%s\",\"offset\":5}", UID);
    reply(PUT5); run(1);
    CHECK(strcmp(F.out, "TAKE 1 5 5\n") == 0, F.out);
    CHECK(F.raw == NULL, "an empty raw section is never armed");
    end_line("1", (const uint8_t *)"hello", 5); run(3);
    CHECK_EQ_INT(F.chunks, 0); CHECK_EQ_INT(F.closes, 1); CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void zero_byte_upload(void) {                            /* Review Focus 2 */
    ready2(); reply("PUT 1 0 1.2.3 0 5:Empty 0:"); run(1);
    CHECK(strcmp(F.out, "TAKE 1 0 0\n") == 0, F.out);
    amiga_sends("END 1 0\n", 8); run(3);
    CHECK_EQ_INT(F.chunks, 0); CHECK(strcmp(F.close_json, "{\"crc32\":0}") == 0, F.close_json);
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void refusals_at_open_become_no_and_keep_the_connection(void) {
    ready2(); F.open_status = 409; snprintf(F.open_resp, sizeof F.open_resp, "{\"code\":\"full\"}");
    reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 full ") != NULL, F.out); CHECK(F.sock == AS_SOCK_OPEN, "kept");
    ready2(); F.open_status = 413; snprintf(F.open_resp, sizeof F.open_resp, "{\"code\":\"size\"}"); reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 size ") != NULL, F.out);
    ready2(); F.open_status = 401; reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 auth ") != NULL, F.out);
    ready2(); F.open_status = 400; snprintf(F.open_resp, sizeof F.open_resp, "{\"code\":\"weird\"}"); reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 server ") != NULL, "an unknown code is server");
    ready2(); reply("PUT 1 4194305 1.2.3 0 1:a 0:"); run(1);
    CHECK(strstr(F.out, "NO 1 size ") != NULL && F.opens == 0, "over 4 MB: refused without asking");
    ready2(); snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"../x\",\"offset\":0}"); reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 server ") != NULL, "an id that is not a uuid never reaches a path");
}
// Task 7 parked item: the server's id goes into a request path -- [0-9a-f-], 1..AS_ID_MAX, nothing else.
static void an_upload_id_the_board_cannot_trust_is_no_server(void) {
    char long_id[AS_ID_MAX + 2];
    memset(long_id, 'a', AS_ID_MAX + 1); long_id[AS_ID_MAX + 1] = 0;   // json_str would cut it to AS_ID_MAX
    const char *bad[] = { "ab?cd", "ab\\rcd", "ab\rcd", "ABCD", "ab cd", "", long_id };
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        ready2(); snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"%s\",\"offset\":0}", bad[i]);
        reply(PUT5); run(2);
        CHECK(strstr(F.out, "NO 1 server ") != NULL, bad[i]);
        CHECK(F.raw == NULL && F.chunks == 0 && F.sock == AS_SOCK_OPEN, "no TAKE: lines, kept");
    }
    char id40[AS_ID_MAX + 1]; memset(id40, 'f', AS_ID_MAX); id40[AS_ID_MAX] = 0;
    ready2(); snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"%s\",\"offset\":0}", id40);
    reply(PUT5); run(1);
    CHECK(strcmp(F.out, "TAKE 1 0 5\n") == 0, "AS_ID_MAX hex digits are fine");
}
static void an_open_that_never_answers_gives_up_after_5_min(void) {
    ready2(); F.open_status = -1;
    reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 1); CHECK(F.out[0] == 0, "nothing yet");
    F.now += 1100; run(1); CHECK_EQ_INT(F.opens, 2);           // the backoff, then again
    F.now += 121000; run(2);
    CHECK(strstr(F.out, "NO 1 ") == NULL, "a Wi-Fi blip of 2 minutes is waited out");
    F.now += 180000; run(2);
    CHECK(strstr(F.out, "NO 1 offline ") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_OPEN, "kept: no byte was in flight");
}
static void a_409_on_a_chunk_ends_the_file_and_the_connection(void) {
    fill_big(); ready2(); put_big(); run(1);
    F.chunk_status = 409; amiga_sends(BIG, CH); run(2);
    CHECK(strstr(F.out, "NO 1 server ") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped: bytes may be in flight (ruling P7)");
}
static void a_failing_chunk_waits_then_gives_up_after_5_min(void) {
    fill_big(); ready2(); put_big(); run(1);
    clear_out();
    F.chunk_status = -1; amiga_sends(BIG, (int)W); run(2);
    CHECK(F.chunks >= 1 && strstr(F.out, "MORE") == NULL, "the credit does not move");
    CHECK(!as_has_work(&S), "in the backoff the long poll runs (ruling P9)");
    F.now += 121000; run(2);
    CHECK(strstr(F.out, "NO 1 ") == NULL && F.sock == AS_SOCK_OPEN, "past 2 minutes: still waiting");
    F.now += 180000; run(2);
    CHECK(strstr(F.out, "NO 1 offline ") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped");
}
// A Wi-Fi or internet outage of a few minutes mid-upload (bench 2026-10-22: 90 s cut, NO offline at 120 s) is waited
// out: the chunks fail, the board backs off, and once the server answers again the file carries on and completes.
static void a_3_minute_outage_mid_upload_resumes(void) {
    fill_big(); ready2(); put_big(); run(1);
    clear_out();
    F.chunk_status = -1; amiga_sends(BIG, (int)W); run(2);
    for (int i = 0; i < 90; i++) { F.now += 2000; run(1); }      // 180 s of failing chunks and backoffs
    CHECK(strstr(F.out, "NO 1 ") == NULL && F.sock == AS_SOCK_OPEN, "still waiting after 3 minutes");
    F.chunk_status = 0;                                          // the network is back
    for (int i = 0; i < 4; i++) { F.now += AS_BACKOFF_MAX_MS; run(3); }
    amiga_sends(BIG + W, (int)(BIGN - W)); end_line("1", BIG, BIGN); run(6);
    CHECK(memcmp(F.stored, BIG, BIGN) == 0, "every byte, in order");
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void an_amiga_that_stops_sending_is_given_up_too(void) {
    fill_big(); ready2(); put_big(); run(1);
    amiga_sends(BIG, 1000); run(1);
    F.now += AS_UP_STALL_MS + 1000u; run(2);
    CHECK(strstr(F.out, "NO 1 offline ") != NULL, F.out);       // PF8, spec �5: a stall is offline either way
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped: raw bytes may be in flight");
}
static void a_crc_refused_at_close_is_no_crc(void) {
    ready2(); F.close_status = 409; snprintf(F.close_resp, sizeof F.close_resp, "{\"code\":\"crc\"}");
    reply(PUT5); run(1); amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK(strstr(F.out, "NO 1 crc ") != NULL, F.out); CHECK(F.sock == AS_SOCK_OPEN, "kept: the stream is lines again");
}
static void done_name_is_latin1(void) {                         /* Review Focus 3 */
    ready2(); snprintf(F.close_resp, sizeof F.close_resp, "{\"name\":\"Caf\xc3\xa9.txt\"}");
    reply("PUT 1 1 1.2.3 0 8:Caf\xe9.txt 0:"); run(1);
    CHECK(strstr(F.open_json, "\"path\":\"Caf\\u00e9.txt\"") != NULL, F.open_json);
    amiga_sends("e", 1); end_line("1", (const uint8_t *)"e", 1); run(4);
    CHECK(strstr(F.out, "DONE 1 8:Caf\xe9.txt\n") != NULL, F.out);
}
static void a_lost_chunk_answer_is_retried(void) {             /* Review Focus 4 */
    ready2(); reply(PUT5); run(1);
    F.lose_answer = 1; amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5);
    run(2);
    CHECK_EQ_INT(F.chunks, 1); CHECK_EQ_INT(F.stored_len, 5);
    F.now += 1100; run(4);
    CHECK_EQ_INT(F.chunks, 2); CHECK_EQ_INT(F.stored_len, 5);   // the retry stored nothing twice
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
static void no_ping_while_a_file_goes_up(void) {
    ready2(); put_big(); run(1); clear_out();
    F.now += 31000; run(2);
    CHECK(strstr(F.out, "PING") == NULL, "no ping in an upload (spec §3)");
}
static void abort_before_the_open_is_answered_no_busy(void) {
    ready2(); F.open_status = -1;
    reply(PUT5); run(1); clear_out();
    reply("ABORT 1"); F.now += 1100; run(2);
    CHECK(strstr(F.out, "NO 1 busy 9:cancelled\n") != NULL, F.out); CHECK(F.sock == AS_SOCK_OPEN, "kept");
}
// Controller ruling (T9 review): an ABORT that crosses the TAKE lands in the raw section as data, and Receive then
// closes. For a tiny file those stray bytes complete the raw section -- so the last chunk waits for END.
static void stray_bytes_completing_a_tiny_raw_section_never_reach_the_server(void) {
    ready2(); reply(PUT5); run(1);
    CHECK(strcmp(F.out, "TAKE 1 0 5\n") == 0, F.out);
    amiga_sends("ABORT 1\n", 8);                     // "ABORT" is the raw section, " 1" a line
    run(3);
    CHECK_EQ_INT(F.chunks, 0);                       // no END: the last chunk is not posted
    F.sock = AS_SOCK_CLOSED;                         // Receive closes (rx_proto.c on_take, up_cancel)
    run(2);
    CHECK_EQ_INT(F.chunks, 0); CHECK_EQ_INT(F.closes, 0);
    CHECK(F.raw == NULL, "disarmed");
}
static void a_second_put_while_one_is_open_drops(void) {
    ready2(); reply(PUT5); run(1);
    reply("PUT 2 5 1.2.3 0 1:x 0:"); run(1);
    CHECK(F.sock == AS_SOCK_CLOSED, "Receive sends one at a time");
}
static void a_dropped_connection_mid_upload_disarms(void) {
    fill_big(); ready2(); put_big(); run(1);
    amiga_sends(BIG, 1000); F.sock = AS_SOCK_CLOSED; run(1);
    CHECK(F.raw == NULL, "disarmed");
}
// Bench B5 (2026-10-21): an Amiga reset mid-upload. The board learns of it only when the Amiga's stack comes back
// and refuses the old connection; the Receive started after the reset waits 60 s, so the idle 30 s cadence (plus a
// connect) missed it. A drop with an upload in flight retries at the waiting cadence, as a waiting download does.
static void a_drop_mid_upload_reconnects_after_5s(void) {
    fill_big(); ready2(); put_big(); run(1);
    amiga_sends(BIG, 1000); F.sock = AS_SOCK_CLOSED; run(1);
    const int c0 = F.connects;
    F.now += AS_RETRY_WAITING_MS - 100; run(3); CHECK_EQ_INT(F.connects, c0);
    F.now += 200; run(3); CHECK_EQ_INT(F.connects, c0 + 1);
}
// ... and a drop with nothing in flight keeps the idle cadence.
static void a_drop_while_idle_keeps_the_30s_cadence(void) {
    ready2(); F.sock = AS_SOCK_CLOSED; run(1);
    const int c0 = F.connects;
    F.now += AS_RETRY_WAITING_MS + 100; run(3); CHECK_EQ_INT(F.connects, c0);
    F.now += AS_RETRY_IDLE_MS; run(3); CHECK_EQ_INT(F.connects, c0 + 1);
}
static void a_put_during_a_download_waits_then_goes_first(void) {
    char q[600], go[80], ok[120];
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    ready2_with(q);
    CHECK(S.phase == AS_FILE_SENT, "the download started");
    reply(PUT5); run(1);
    CHECK_EQ_INT(F.opens, 0);                                      // it waits for the file going down
    memcpy(F.file, "hello", 5); F.file_len = 5;
    snprintf(go, sizeof go, "GO %s", ID); reply(go); run(3);
    snprintf(ok, sizeof ok, "OK %s 5:Hello", ID); reply(ok);
    run(6);
    CHECK_EQ_INT(F.posts, 1);                                      // the download's outcome first
    CHECK_EQ_INT(F.opens, 1);                                      // then the PUT, before the next download
}
// The 60 s open give-up counts the open's own tries (spec �8), not the time a PUT waited for a download's turn.
static void a_put_that_waited_out_a_long_download_still_opens(void) {
    char q[600], go[80], ok[120];
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    ready2_with(q);
    reply(PUT5); run(1);
    memcpy(F.file, "hello", 5); F.file_len = 5;
    F.now += AS_GO_MS - 1000;
    snprintf(go, sizeof go, "GO %s", ID); reply(go); run(3);
    F.now += 50000;                                                // Receive takes its time to answer OK
    snprintf(ok, sizeof ok, "OK %s 5:Hello", ID); reply(ok);
    clear_out(); run(6);
    CHECK_EQ_INT(F.opens, 1);
    CHECK(strstr(F.out, "TAKE 1 0 5\n") != NULL && strstr(F.out, "NO 1") == NULL, F.out);
}
static void after_an_upload_a_waiting_download_goes_first(void) {
    char q[600];
    ready2(); reply(PUT5); run(1);
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    snprintf(F.queue, sizeof F.queue, "%s", q); as_set_inputs(&S, true, 0xAC100AEDu, 2);   // a download arrives meanwhile
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5);
    run(2);                                                        // the chunk, then the close: DONE; the queue not refetched yet
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
    reply("PUT 2 5 1.2.3 0 9:Hello.txt 0:");                       // Receive offers its next file at once
    run(6);
    CHECK_EQ_INT(F.opens, 1);                                      // the second PUT waits its turn
    CHECK(strstr(F.out, "FILE ") != NULL, "the download goes first");
}

// Fix round 1, item 2: an upload that ends without a drop leaves nothing armed.
static void an_upload_that_ends_on_lines_leaves_the_raw_section_disarmed(void) {
    ready2(); reply(PUT5); run(1);
    CHECK(F.armed != NULL, "armed for the TAKE");
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
    CHECK(F.armed == NULL, "disarmed after DONE");
    ready2(); F.close_status = 409; snprintf(F.close_resp, sizeof F.close_resp, "{\"code\":\"crc\"}");
    reply(PUT5); run(1); amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK(strstr(F.out, "NO 1 crc ") != NULL, F.out);
    CHECK(F.armed == NULL, "disarmed after a NO at the close");
}
// Fix round 1, item 3, revised (increment-2 review, item 4): the upload's turn waits for a PONG still owed, so the
// PONG arrives as a line before the raw section is armed -- and the connection is not dropped after the upload.
static void a_ping_owed_when_an_upload_starts_does_not_drop_after_it(void) {
    ready2();
    F.now += AS_PING_MS + 1; run(1);
    CHECK(strcmp(F.out, "PING\n") == 0, F.out);
    reply(PUT5); run(1);                               // Receive's PUT crossed the PING
    reply("PONG"); run(1);
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
    F.now += AS_PONG_MS + 1; run(2);
    CHECK(F.sock == AS_SOCK_OPEN, "not dropped for a PONG owed before the upload");
}
// Increment-2 review, item 4: a PONG that crosses the TAKE would land in the raw ring as file data. The turn waits.
static void a_pong_owed_at_the_upload_turn_is_read_as_a_line_first(void) {
    ready2();
    F.now += AS_PING_MS + 1; run(1);
    CHECK(strcmp(F.out, "PING\n") == 0, F.out);
    clear_out();
    amiga_sends("PUT 1 5 1.2.3 0 9:Hello.txt 0:\n", 31); run(2);
    CHECK_EQ_INT(F.opens, 0);                          // no open, no TAKE, nothing armed while the PONG is owed
    CHECK(strstr(F.out, "TAKE") == NULL && F.armed == NULL, F.out);
    amiga_sends("PONG\n", 5); run(2);
    CHECK(strcmp(F.out, "TAKE 1 0 5\n") == 0, F.out);
    CHECK(UP.raw.got == 0, "the PONG never reached the ring");
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK(memcmp(F.stored, "hello", 5) == 0 && F.stored_len == 5, "the file's own bytes only");
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
// ... and a PONG that never comes drops the connection as ever, the PUT unopened.
static void a_pong_that_never_comes_at_the_upload_turn_drops(void) {
    ready2();
    F.now += AS_PING_MS + 1; run(1);
    reply(PUT5); run(1);
    F.now += AS_PONG_MS + 1; run(2);
    CHECK_EQ_INT(F.opens, 0);
    CHECK(F.sock == AS_SOCK_CLOSED, "no PONG: dropped");
}
// Increment-2 review, item 1: Receive CRCs the resumed part before its first raw byte (or END), silently. On a 7 MHz
// 68000 that takes minutes for 4 MB, so the stall clock allows AS_UP_PREREAD_MS(offset) for it.
#define RESUME_SIZE 4194304u
#define RESUME_OFF  3145728u
static void a_resume_far_into_the_file_waits_for_receives_pre_read(void) {
    char l[80];
    ready2();
    snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"%s\",\"offset\":%u}", UID, RESUME_OFF);
    snprintf(l, sizeof l, "PUT 1 %u 1.2.3 0 3:Big 0:", RESUME_SIZE); reply(l); run(1);
    CHECK(strncmp(F.out, "TAKE 1 3145728 ", 15) == 0, F.out);
    const uint32_t allow = AS_UP_PREREAD_MS(RESUME_OFF);
    CHECK(allow > AS_UP_STALL_MS + 300000u, "at least 5 minutes more for 3 MB");
    F.now += AS_UP_STALL_MS + 60000u; run(2);
    CHECK(strstr(F.out, "NO 1 ") == NULL && F.sock == AS_SOCK_OPEN, "past 120 s but within the allowance: waits");
    F.now += allow - (AS_UP_STALL_MS + 60000u) + 1000u; run(2);
    CHECK(strstr(F.out, "NO 1 offline ") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_CLOSED, "past the allowance: given up");
}
// Once the first raw byte is in, the plain stall (AS_UP_STALL_MS) applies again.
static void after_the_pre_read_the_plain_stall_applies(void) {
    char l[80];
    fill_big(); ready2();
    snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"%s\",\"offset\":%u}", UID, RESUME_OFF);
    snprintf(l, sizeof l, "PUT 1 %u 1.2.3 0 3:Big 0:", RESUME_SIZE); reply(l); run(1);
    F.now += AS_UP_STALL_MS + 60000u; run(1);
    amiga_sends(BIG, 1000); run(1);                    // the pre-read is over
    F.now += AS_UP_STALL_MS + 1000u; run(2);
    CHECK(strstr(F.out, "NO 1 offline ") != NULL, F.out);
}
// A resume at the file's size: the pre-read is the whole file, then END, then the close -- not NO offline.
static void a_resume_at_size_after_a_long_pre_read_closes(void) {
    char l[80];
    ready2();
    snprintf(F.open_resp, sizeof F.open_resp, "{\"id\":\"%s\",\"offset\":%u}", UID, RESUME_SIZE);
    snprintf(l, sizeof l, "PUT 1 %u 1.2.3 0 3:Big 0:", RESUME_SIZE); reply(l); run(1);
    CHECK(strcmp(F.out, "TAKE 1 4194304 4194304\n") == 0, F.out);
    F.now += AS_UP_STALL_MS + 280000u; run(2);         // 400 s of CRC over 4 MB
    CHECK(strstr(F.out, "NO 1 ") == NULL, F.out);
    amiga_sends("END 1 1234abcd\n", 15); run(3);
    CHECK_EQ_INT(F.closes, 1);
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
}
// Increment-2 review, item 5: a chunk answered 404 is a file deleted on the web app mid-upload.
static void a_chunk_404_is_no_gone(void) {
    fill_big(); ready2(); put_big(); run(1);
    F.chunk_status = 404; amiga_sends(BIG, CH); run(2);
    CHECK(strstr(F.out, "NO 1 gone 22:deleted on the web app\n") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_CLOSED, "dropped: bytes may be in flight");
}
static void a_close_gone_is_no_gone(void) {
    ready2(); F.close_status = 404; snprintf(F.close_resp, sizeof F.close_resp, "{\"code\":\"gone\"}");
    reply(PUT5); run(1); amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK(strstr(F.out, "NO 1 gone 22:deleted on the web app\n") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_OPEN, "kept: the stream is lines again");
}
// Fix round 1, item 4: right after an upload, a queue fetch that keeps failing does not hold the next PUT forever.
static void a_failing_fetch_after_an_upload_does_not_hold_the_next_put(void) {
    ready2(); reply(PUT5); run(1);
    amiga_sends("hello", 5); end_line("1", (const uint8_t *)"hello", 5); run(4);
    CHECK(strstr(F.out, "DONE 1 ") != NULL, F.out);
    F.queue_status = -1; as_set_inputs(&S, true, 0xAC100AEDu, 2);   // a new queue version; the fetch fails
    run(2);
    CHECK(F.queue_fetches >= 2, "the fetch was tried");
    clear_out();
    reply("PUT 2 5 1.2.3 0 9:Hello.txt 0:");
    run(1);                                            // its turn, during the backoff
    F.now += AS_BACKOFF_MAX_MS; run(2);                // the backoff over: the open, not another fetch
    CHECK_EQ_INT(F.opens, 2);                          // not held by an "unsure" queue
    CHECK(strstr(F.out, "TAKE 2 0 5\n") != NULL, F.out);
}
// ... and no path holds a waiting PUT longer than AS_UP_OPEN_GIVEUP_MS: an outcome the server keeps refusing.
static void a_put_behind_a_failing_outcome_gets_no_offline(void) {
    char q[600], go[80], ok[120];
    snprintf(q, sizeof q, "NEXT %s 5 3610a686 0 5:Hello 0:\nLIST 1\n%s 5 5:Hello\n", ID, ID);
    ready2_with(q);
    memcpy(F.file, "hello", 5); F.file_len = 5;
    reply(PUT5); run(1);
    snprintf(go, sizeof go, "GO %s", ID); reply(go); run(3);
    F.post_status = 503;                               // the download's outcome cannot be posted
    snprintf(ok, sizeof ok, "OK %s 5:Hello", ID); reply(ok); run(2);
    for (int i = 0; i < 160; i++) { F.now += 2000; run(1); }     // 320 s of backoffs
    CHECK_EQ_INT(F.opens, 0);                          // the outcome goes first, so the open never ran
    CHECK(strstr(F.out, "NO 1 offline ") != NULL, F.out);
    CHECK(F.sock == AS_SOCK_OPEN, "kept: no raw byte was in flight");
}
// Fix round 1, item 5: the server's busy is not the user's cancel.
static void a_server_busy_at_open_is_not_called_cancelled(void) {
    ready2(); F.open_status = 409; snprintf(F.open_resp, sizeof F.open_resp, "{\"code\":\"busy\"}");
    reply(PUT5); run(1);
    CHECK(strstr(F.out, "NO 1 busy ") != NULL && strstr(F.out, "cancelled") == NULL, F.out);
    CHECK(strstr(F.out, "NO 1 busy 19:the web app is busy\n") != NULL, F.out);
}
int main(void) {
    RUN(off_or_no_address_does_nothing);
    RUN(connects_to_6800_and_says_hello);
    RUN(refused_then_retried_after_30s_with_nothing_waiting);
    RUN(retried_after_5s_while_a_file_waits);
    RUN(connect_timeout_is_unreachable);
    RUN(no_ready_is_unreachable);
    RUN(one_file_end_to_end);
    RUN(next_file_follows_without_a_long_poll);
    RUN(err_before_go_is_posted);
    RUN(big_file_in_chunks);
    RUN(partial_send_finishes_chunk_before_next_fetch);
    RUN(zero_length_goes_straight_to_ok);
    RUN(drop_mid_data_posts_nothing_and_resends);
    RUN(receive_closed_mid_file);
    RUN(cancel_409_aborts);
    RUN(failed_post_is_retried_and_409_counts_as_landed);
    RUN(pings_when_idle_and_drops_without_pong);
    RUN(new_queue_version_refetches_and_forwards_list);
    RUN(json_escapes_latin1);
    RUN(turning_network_off_closes);
    RUN(without_buffers_it_never_runs);
    RUN(longest_legal_next_line_goes_out_whole);
    RUN(unreadable_next_is_failed_not_looped);
    RUN(failed_fetch_backs_off);
    RUN(failed_post_backs_off_and_400_is_final);
    RUN(long_latin1_saved_name_is_cut_not_emptied);
    RUN(the_hello_carries_the_key);
    RUN(without_a_key_or_state_the_hello_stays_protocol_1);
    RUN(raw_bytes_land_in_the_ring_and_the_rest_are_lines);
    RUN(a_byte_past_the_credit_breaks_it);
    RUN(the_ring_wraps_at_its_size);
    RUN(put_parses_and_json_escapes_latin1);
    RUN(the_worst_put_json_fits);
    RUN(utf8_comes_back_as_latin1);
    RUN(ready_2_lets_a_put_in_and_ready_1_does_not);
    RUN(a_ready_2_to_a_protocol_1_hello_lets_no_put_in);
    RUN(a_small_upload_end_to_end);
    RUN(a_big_upload_moves_in_16k_chunks_and_the_credit_follows);
    RUN(bytes_past_the_credit_drop_the_connection);
    RUN(the_servers_offset_resumes_the_file);
    RUN(resume_at_size_goes_straight_to_close);
    RUN(zero_byte_upload);
    RUN(refusals_at_open_become_no_and_keep_the_connection);
    RUN(an_upload_id_the_board_cannot_trust_is_no_server);
    RUN(an_open_that_never_answers_gives_up_after_5_min);
    RUN(a_409_on_a_chunk_ends_the_file_and_the_connection);
    RUN(a_failing_chunk_waits_then_gives_up_after_5_min);
    RUN(a_3_minute_outage_mid_upload_resumes);
    RUN(an_amiga_that_stops_sending_is_given_up_too);
    RUN(a_crc_refused_at_close_is_no_crc);
    RUN(done_name_is_latin1);
    RUN(a_lost_chunk_answer_is_retried);
    RUN(no_ping_while_a_file_goes_up);
    RUN(abort_before_the_open_is_answered_no_busy);
    RUN(stray_bytes_completing_a_tiny_raw_section_never_reach_the_server);
    RUN(a_second_put_while_one_is_open_drops);
    RUN(a_dropped_connection_mid_upload_disarms);
    RUN(a_put_during_a_download_waits_then_goes_first);
    RUN(after_an_upload_a_waiting_download_goes_first);
    RUN(a_put_that_waited_out_a_long_download_still_opens);
    RUN(an_upload_that_ends_on_lines_leaves_the_raw_section_disarmed);
    RUN(a_ping_owed_when_an_upload_starts_does_not_drop_after_it);
    RUN(a_pong_owed_at_the_upload_turn_is_read_as_a_line_first);
    RUN(a_pong_that_never_comes_at_the_upload_turn_drops);
    RUN(a_resume_far_into_the_file_waits_for_receives_pre_read);
    RUN(after_the_pre_read_the_plain_stall_applies);
    RUN(a_resume_at_size_after_a_long_pre_read_closes);
    RUN(a_chunk_404_is_no_gone);
    RUN(a_close_gone_is_no_gone);
    RUN(a_failing_fetch_after_an_upload_does_not_hold_the_next_put);
    RUN(a_put_behind_a_failing_outcome_gets_no_offline);
    RUN(a_server_busy_at_open_is_not_called_cancelled);
    RUN(a_drop_mid_upload_reconnects_after_5s);
    RUN(a_drop_while_idle_keeps_the_30s_cadence);
    RUN(the_hello_is_protocol_3_with_requests);
    RUN(without_requests_the_hello_stays_2);
    RUN(a_ready_3_to_a_protocol_2_hello_counts_as_1);
    RUN(transfer_2_2_answers_ready_2_and_requests_get_old);
    RUN(vols_is_relayed_and_answered_in_one_piece);
    RUN(the_ack_is_the_v_seen_before_the_fetch);
    RUN(requests_go_one_at_a_time_in_order);
    RUN(a_drawer_of_latin1_names_arrives_in_pieces_under_32k);
    RUN(a_piece_closes_at_400_lines);
    RUN(lines_wait_in_the_socket_while_a_piece_cannot_post);
    RUN(norx_when_transfer_is_not_connected);
    RUN(a_close_at_protocol_3_reconnects_in_5s_and_reports_browse);
    RUN(silent_transfer_mid_answer_is_timeout_and_drops);
    RUN(a_dropped_connection_mid_answer_ends_norx_lost);
    RUN(a_request_waits_behind_a_moving_download);
    RUN(a_request_goes_before_a_queued_download);
    RUN(a_put_that_crosses_a_request_goes_first);
    RUN(browse_off_still_relays_and_transfer_says_off);
    RUN(a_failing_fetch_backs_off);
    RUN(a_put_that_crosses_a_request_after_an_upload_goes_first);
    RUN(no_ping_while_lines_wait_for_a_piece);
    RUN(a_403_piece_is_refused_not_retried);
    return REPORT();
}
