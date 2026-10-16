#ifndef AMIGA_SEND_H
#define AMIGA_SEND_H
// PaulaNET Phase 4 (spec docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md §2-3): files
// queued on the server for this board go to Receive on the Amiga. The board connects to the Amiga's TCP 6800 over
// the PaulaNET local path, says hello, forwards the server's LIST block, then for the queue's NEXT file sends FILE,
// waits for GO, streams the file chunk by chunk from the server, and posts Receive's OK or ERR back to the server.
//
// Pure: every socket and HTTPS call goes through as_ops_t (amiga_tcp.c on the board, a scripted fake in
// test/test_amiga_send.c). RULE: no pico-sdk or lwIP header here -- it is compiled into every host test.
//
// ONE HTTPS REQUEST PER as_step(), and none from as_tick(): the board has one HTTPS connection, shared with the poll
// and the uploader. core1 calls as_tick() every pass and, while as_has_work(), as_step() instead of the long poll.
#include <stdbool.h>
#include <stdint.h>

#define AS_PORT 6800
#define AS_QUEUE_BYTES 6144          // = the server's SEND_QUEUE_BYTES
#define AS_CHUNK_BYTES 16384         // = the server's SEND_CHUNK_MAX
#define AS_LINE_MAX 320
#define AS_ID_MAX 40
#define AS_RETRY_WAITING_MS 5000u    // reconnect cadence while a file waits
#define AS_RETRY_IDLE_MS 30000u      // ... and while nothing does (so the card can say whether Receive runs)
#define AS_CONNECT_MS 10000u
#define AS_HELLO_MS 10000u
#define AS_GO_MS 30000u
#define AS_PING_MS 30000u
#define AS_PONG_MS 10000u

enum { AS_SOCK_CLOSED, AS_SOCK_CONNECTING, AS_SOCK_OPEN, AS_SOCK_REFUSED };

typedef struct as_ops {
    void *ctx;
    int  (*connect)(void *ctx, uint32_t ip_host_order, uint16_t port);   // 0 = started, <0 = could not start
    int  (*sock_state)(void *ctx);                                        // AS_SOCK_*
    int  (*send)(void *ctx, const uint8_t *b, int n);    // bytes accepted now (0..n), <0 = broken
    int  (*recv_line)(void *ctx, char *out, int cap);    // 1 = a line (no LF), 0 = none yet, <0 = closed
    void (*close)(void *ctx);
    int  (*fetch_queue)(void *ctx, char *buf, int cap);  // body length, <0 = failed
    int  (*fetch_chunk)(void *ctx, const char *id, uint32_t off, uint32_t len, uint8_t *buf); // bytes, or -status/-1
    int  (*post_done)(void *ctx, const char *id, const char *json);      // http status, <0 = failed
    uint32_t (*now_ms)(void *ctx);
} as_ops_t;

typedef enum { AS_IDLE, AS_CONNECTING, AS_HELLO, AS_READY, AS_FILE_SENT, AS_DATA, AS_AWAIT_OK } as_phase_t;

// One instance. Fields are private to amiga_send.c. The two big buffers (22 KB) are the caller's: on the board they
// live in PSRAM (main.c), because 22 KB of SRAM would come straight out of the heap TLS allocates from.
typedef struct amiga_send {
    const as_ops_t *ops;
    bool net_on;
    uint32_t ip;
    uint32_t want_version, have_version;
    bool fetched_once, force_fetch;
    as_phase_t phase;
    char rx;
    uint32_t t_phase, t_retry, t_ping;
    bool ping_out;
    char *queue;                     // AS_QUEUE_BYTES + 1, the caller's
    int queue_len;
    bool list_owed;
    const uint8_t *out_p;            // bytes still to push (a line, the LIST block, a chunk)
    int out_n;
    char out_line[AS_LINE_MAX + 8];
    char id[AS_ID_MAX + 1];
    uint32_t size, off, chunk_len;
    uint8_t *chunk;                  // AS_CHUNK_BYTES, the caller's
    char done_id[AS_ID_MAX + 1];
    char done_json[480];
    bool done_owed;
    char line[AS_LINE_MAX + 1];
} amiga_send_t;

// queue_buf: AS_QUEUE_BYTES + 1 bytes; chunk_buf: AS_CHUNK_BYTES. Either NULL disables sending (no PSRAM).
void as_init(amiga_send_t *s, const as_ops_t *ops, char *queue_buf, uint8_t *chunk_buf);
// From core1 each pass: Network mode on, the Amiga's address (0 = none yet), the poll's xfer.v.
void as_set_inputs(amiga_send_t *s, bool net_on, uint32_t amiga_ip, uint32_t queue_version);
// Cheap, every pass, never an HTTPS request: connect retries, the handshake, pings, Receive's replies, pushing bytes.
void as_tick(amiga_send_t *s);
// True while a file is moving, a reply is awaited, the queue must be fetched or an outcome posted: skip the long poll.
bool as_has_work(const amiga_send_t *s);
// One bounded unit of work: at most one HTTPS request. Returns whether anything moved (false: core1 may pause).
bool as_step(amiga_send_t *s);
char as_rx(const amiga_send_t *s);               // 'c' connected, 'r' refused, 'u' unreachable, '-' unknown/off
uint32_t as_acked_version(const amiga_send_t *s);// the queue version last fetched: the poll's xferAck
// JSON string body: '"' and '\\' escaped, control and non-ASCII bytes as \u00XX. Returns length, or -1 if it won't fit.
int as_json_escape(char *dst, int cap, const char *src, int n);

#endif
