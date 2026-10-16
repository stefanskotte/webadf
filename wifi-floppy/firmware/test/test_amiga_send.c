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
static const as_ops_t OPS = { NULL, f_connect, f_state, f_send, f_recv, f_close, f_queue, f_chunk, f_post, f_now };

static amiga_send_t S;
static void reply(const char *l) { snprintf(F.in[F.in_tail], AS_LINE_MAX + 1, "%s", l); F.in_tail = (F.in_tail + 1) % 16; }
static char QBUF[AS_QUEUE_BYTES + 1];
static uint8_t CBUF[AS_CHUNK_BYTES];
static void fresh(void) { memset(&F, 0, sizeof F); F.now = 1000; as_init(&S, &OPS, QBUF, CBUF); }
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
    memset(&F, 0, sizeof F); F.now = 1000; as_init(&S, &OPS, NULL, NULL);
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

int main(void) {
    RUN(off_or_no_address_does_nothing);
    RUN(connects_to_6800_and_says_hello);
    RUN(refused_then_retried_after_30s_with_nothing_waiting);
    RUN(retried_after_5s_while_a_file_waits);
    RUN(connect_timeout_is_unreachable);
    RUN(no_ready_is_unreachable);
    RUN(one_file_end_to_end);
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
    return REPORT();
}
