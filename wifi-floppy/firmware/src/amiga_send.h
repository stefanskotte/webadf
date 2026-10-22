#ifndef AMIGA_SEND_H
#define AMIGA_SEND_H
// PaulaNET Phase 4 (spec docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md §2-3): files
// queued on the server for this board go to Receive on the Amiga. The board connects to the Amiga's TCP 6800 over
// the PaulaNET local path, says hello, forwards the server's LIST block, then for the queue's NEXT file sends FILE,
// waits for GO, streams the file chunk by chunk from the server, and posts Receive's OK or ERR back to the server.
// Protocol 2 (spec 2026-10-18-amiga-to-web-upload-design.md §3, §5; fw 1.19.0): Receive 2 offers files with PUT; the
// board opens an upload on the server, lands Receive's raw bytes in a PSRAM ring within a credit (TAKE/MORE), posts
// each 16 KB chunk, and closes the upload at END (DONE or NO).
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
#define AS_CHUNK_BYTES 16384         // = the server's SEND_CHUNK_MAX and UPLOAD_CHUNK
#define AS_LINE_MAX 640              // = Receive's RX_LINE_MAX: the longest legal FILE line is 398
#define AS_ID_MAX 40
#define AS_RETRY_WAITING_MS 5000u    // reconnect cadence while a file waits
#define AS_RETRY_IDLE_MS 30000u      // ... and while nothing does (so the card can say whether Receive runs)
#define AS_CONNECT_MS 10000u
#define AS_HELLO_MS 10000u
#define AS_GO_MS 30000u
#define AS_PING_MS 30000u
#define AS_PONG_MS 10000u
#define AS_BACKOFF_MIN_MS 1000u      // a failed HTTPS call waits this long, doubling
#define AS_BACKOFF_MAX_MS 30000u     //   to this; the board long-polls meanwhile

// Uploads (protocol 2, spec 2026-10-18 §3, §5).
#define AS_KEY_HEX 32                // the board key in the hello
#define AS_TAG_MAX 9                 // Receive's tag: 1-9 decimal digits
#define AS_UP_FILE_MAX 4194304u      // = Receive's RX_FILE_MAX and the server's UPLOAD_FILE_MAX
#ifndef AS_UP_WINDOW_CHUNKS
#define AS_UP_WINDOW_CHUNKS 2u       // the credit window in chunks (spec §3: 32 KB). From plan 2026-10-19 Task 1's measurement.
#endif
#define AS_UP_RING_BYTES (AS_UP_WINDOW_CHUNKS * AS_CHUNK_BYTES)   // the caller's chunk buffer is this big
#ifndef AS_UP_OOSEQ_BYTES
#define AS_UP_OOSEQ_BYTES 2920u      // out-of-order bytes lwIP may hold for the Amiga's pcb (two segments). From Task 1.
#endif
// A network outage of a few minutes is waited out, not reported (operator 2026-10-22, after the bench's 90 s cut
// ended in NO offline): the open and a stalled upload both wait 5 minutes. Transfer's own silence limit during an
// upload, RX_UP_IDLE_SECS (tools/receive), must stay above both -- it is 360 s from Transfer 2.2.
#define AS_UP_OPEN_GIVEUP_MS 300000u // the server never answered the open: NO offline (spec §8)
#define AS_UP_STALL_MS 300000u       // no progress this long: NO offline (spec §5)
// A resume at <off>: Receive reads and CRCs the first <off> bytes, silently, before its first raw byte (or END). The
// stall clock allows that much more, at 8 KB/s worst case (off/8 ms): 4 MB is about 11 minutes in all. The 8 KB/s is
// an assumption for a 7 MHz 68000 reading from floppy, not a measurement: bench B5 (Resume) times it -- the log's
// "up: <tag> open ... at <off>" to the first chunk -- and a resume far into a 4 MB file from DF0: is the case to time
// (plan 2026-10-19, Bench). A measured rate below 8 KB/s replaces the divisor.
#define AS_UP_PREREAD_MS(off) (AS_UP_STALL_MS + (uint32_t)(off) / 8u)
#define AS_UP_JSON_MAX 2200          // the open body at its worst: 255 path and 79 comment bytes, each \u00XX
#define AS_UP_RESP_MAX 768           // the server's answer (the stored name, UTF-8, escaped)

enum { AS_SOCK_CLOSED, AS_SOCK_CONNECTING, AS_SOCK_OPEN, AS_SOCK_REFUSED };

// An upload's raw section: Receive's bytes land in the ring from the TCP receive callback (amiga_tcp.c calls
// as_raw_feed in lwIP's context), never past the credit. got is written only by as_raw_feed, limit only by the engine.
typedef struct as_raw {
    uint8_t *ring;               // AS_UP_RING_BYTES: chunk k is at (k % AS_UP_WINDOW_CHUNKS) * AS_CHUNK_BYTES
    uint32_t total;              // bytes in the raw section (size - the resume offset)
    volatile uint32_t limit;     // the credit, relative to the section's start
    volatile uint32_t got;       // bytes landed
    volatile bool broken;        // a byte past the credit came: Receive broke the protocol
} as_raw_t;

// "PUT <tag> <size> <days>.<mins>.<ticks> <prot hex> <len>:<path> <len>:<comment>", parsed. path and comment point
// into the line (Latin-1, not NUL-terminated).
typedef struct as_put {
    char tag[AS_TAG_MAX + 1];
    uint32_t size, prot;
    char date[24];
    const char *path; int path_n;
    const char *comment; int comment_n;
} as_put_t;

// The upload's state: the caller's, in PSRAM on the board (plan ruling P1).
typedef struct as_up {
    as_raw_t raw;
    char key[AS_KEY_HEX + 1];        // the board key for the hello; "" = protocol 1 only
    bool pending;                    // a PUT waits for its turn
    bool aborted;                    // Receive sent ABORT for it
    char put[AS_LINE_MAX + 1];       // that PUT as Receive sent it
    char tag[AS_TAG_MAX + 1];
    char id[AS_ID_MAX + 1];          // the server's upload id
    uint32_t size, start, posted, crc, last_got, t_open, t_progress;   // start: the server's offset at open; posted: absolute
    bool end_seen;
    char json[AS_UP_JSON_MAX];       // the open body, then the close body; after the close, scratch
    char resp[AS_UP_RESP_MAX];       // the server's answer
    char line[AS_LINE_MAX + 8];      // the hello, TAKE, MORE, DONE or NO going out
} as_up_t;

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
    // Protocol 2. Each is one HTTPS request: http status, <0 failed; resp gets the body.
    int  (*upload_open)(void *ctx, const char *json, char *resp, int cap);
    int  (*upload_chunk)(void *ctx, const char *id, uint32_t off, const uint8_t *b, uint32_t n, char *resp, int cap);
    int  (*upload_close)(void *ctx, const char *id, const char *json, char *resp, int cap);
    // The raw section starts with the next byte from the Amiga (NULL: none). Armed before the TAKE goes out.
    void (*raw_arm)(void *ctx, as_raw_t *w);
} as_ops_t;

typedef enum { AS_IDLE, AS_CONNECTING, AS_HELLO, AS_READY, AS_FILE_SENT, AS_DATA, AS_AWAIT_OK,
               AS_UP_OPEN, AS_UP_DATA, AS_UP_CLOSE } as_phase_t;

// One instance. Fields are private to amiga_send.c. The big buffers are the caller's: on the board they live in PSRAM
// (main.c), because SRAM would come straight out of the heap TLS allocates from.
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
    uint8_t *chunk;                  // AS_UP_RING_BYTES, the caller's (sends use the first AS_CHUNK_BYTES)
    char done_id[AS_ID_MAX + 1];
    char done_json[480];
    bool done_owed;
    uint32_t backoff_ms, t_backoff;  // after a failed HTTPS call: no work until t_backoff
    char line[AS_LINE_MAX + 1];
    as_up_t *up;                     // the caller's (PSRAM); NULL: no uploads
    uint8_t hello_v;                 // the hello this connection sent: 1 or 2
    uint8_t peer_v;                  // Receive's READY: 2 only in answer to our protocol 2 hello, else 1 (0 before)
    bool up_last;                    // the last file to finish went up: a waiting download goes next (spec §3)
} amiga_send_t;

// queue_buf: AS_QUEUE_BYTES + 1 bytes; chunk_buf: AS_UP_RING_BYTES. Either NULL disables sending (no PSRAM).
// up: NULL disables uploads (the hello stays protocol 1).
void as_init(amiga_send_t *s, const as_ops_t *ops, char *queue_buf, uint8_t *chunk_buf, as_up_t *up);
// The board key (32 lower-case hex digits); anything else keeps the hello at protocol 1.
void as_set_key(amiga_send_t *s, const char *hex32);
// From core1 each pass: Network mode on, the Amiga's address (0 = none yet), the poll's xfer.v.
void as_set_inputs(amiga_send_t *s, bool net_on, uint32_t amiga_ip, uint32_t queue_version);
// Cheap, every pass, never an HTTPS request: connect retries, the handshake, pings, Receive's replies, pushing bytes.
void as_tick(amiga_send_t *s);
// True while a file is moving either way, a reply is awaited, the queue must be fetched, an outcome posted, or a PUT
// waits: skip the long poll. False during a backoff (the long poll runs; plan ruling P9).
bool as_has_work(const amiga_send_t *s);
// One bounded unit of work: at most one HTTPS request. Returns whether anything moved (false: core1 may pause).
bool as_step(amiga_send_t *s);
char as_rx(const amiga_send_t *s);               // 'c' connected, 'r' refused, 'u' unreachable, '-' unknown/off
uint32_t as_acked_version(const amiga_send_t *s);// the queue version last fetched: the poll's xferAck
// JSON string body: '"' and '\\' escaped, control and non-ASCII bytes as \u00XX. Cut to fit (whole escapes only):
// returns the length written.
int as_json_escape(char *dst, int cap, const char *src, int n);
// lwIP's context: n bytes from the Amiga. Returns how many belong to the raw section (0..n; the rest are lines),
// or -1 when one would pass the credit (w->broken is set).
int as_raw_feed(as_raw_t *w, const uint8_t *b, int n);
// The server's UTF-8 (every character <= U+00FF) as Latin-1; anything else '?'. Returns the length.
int as_utf8_to_latin1(const char *in, char *out, int cap);
bool as_put_parse(const char *line, as_put_t *out);
// The open's JSON: {"size":..,"date":"..","protection":..,"path":"..","comment":".."}; length, or -1 if it cannot fit.
int as_put_json(const as_put_t *p, char *json, int cap);

#endif
