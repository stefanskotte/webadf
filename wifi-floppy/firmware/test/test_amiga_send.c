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
    char partial[AS_LINE_MAX + 1]; int partial_n;      // a line from the Amiga being built
    int opens, open_status; char open_json[AS_UP_JSON_MAX]; char open_resp[256];
    int chunks, chunk_status; uint32_t chunk_offs[300], chunk_lens[300]; uint8_t stored[200000]; uint32_t stored_len;
    int lose_answer;                                   // the next chunk is stored but answered -1 (a lost answer)
    int closes, close_status; char close_json[128]; char close_resp[512];
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
    snprintf(resp, (size_t)cap, "%s", F.open_resp[0] ? F.open_resp : "{\"id\":\"u1\",\"offset\":0}");
    return F.open_status ? F.open_status : 200;
}
static int f_up_chunk(void *c, const char *id, uint32_t off, const uint8_t *b, uint32_t n, char *resp, int cap) {
    (void)c; (void)id;
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
    (void)c; (void)id; F.closes++; snprintf(F.close_json, sizeof F.close_json, "%s", json);
    snprintf(resp, (size_t)cap, "%s", F.close_resp[0] ? F.close_resp : "{\"name\":\"Hello.txt\"}");
    return F.close_status ? F.close_status : 200;
}
static void f_raw_arm(void *c, as_raw_t *w) { (void)c; F.raw = (w && w->got < w->total) ? w : NULL; F.arms++; }
static const as_ops_t OPS = { NULL, f_connect, f_state, f_send, f_recv, f_close, f_queue, f_chunk, f_post, f_now, f_up_open, f_up_chunk, f_up_close, f_raw_arm };

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
__attribute__((unused)) static void amiga_sends(const void *data, int n) {
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
__attribute__((unused)) static void ready2(void) {
    fresh();
    as_set_key(&S, KEY);
    snprintf(F.queue, sizeof F.queue, "NEXT -\nLIST 0\n");
    as_set_inputs(&S, true, 0xAC100AEDu, 1);
    run(2); F.sock = AS_SOCK_OPEN; run(1);
    reply("READY 2"); run(2);
    clear_out();
}
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
    CHECK(as_put_json(&p, json, sizeof json) > 0, "json");
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
    char com[80]; memset(com, '"', 79); com[79] = 0;
    snprintf(line, sizeof line, "PUT 999999999 4194304 99999.1439.2999 ffffffff 255:%s 79:%s", name, com);
    CHECK(as_put_parse(line, &p), "the longest legal PUT");
    CHECK(as_put_json(&p, json, sizeof json) > 0, "its JSON fits AS_UP_JSON_MAX, never cut");
}
static void utf8_comes_back_as_latin1(void) {
    char out[32];
    CHECK_EQ_INT(as_utf8_to_latin1("Caf\xc3\xa9.txt", out, sizeof out), 8);
    CHECK(strcmp(out, "Caf\xe9.txt") == 0, "é");
    as_utf8_to_latin1("a\xe2\x82\xac" "b", out, sizeof out);
    CHECK(strcmp(out, "a?b") == 0, "beyond Latin-1: ?");
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
    return REPORT();
}
