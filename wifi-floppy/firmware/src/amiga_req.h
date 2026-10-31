#ifndef AMIGA_REQ_H
#define AMIGA_REQ_H
// NET: volumes (spec docs/superpowers/specs/2026-10-30-net-volumes-design.md section 3; fw 1.22.0): the server's
// requests (VOLS, DIR, GET) reach Transfer through the board, and Transfer's answers come back as pieces. This is the
// pure part: the fetched request lines, the answer piece's JSON body, and the GETs answered GOT whose files have not
// finished. amiga_send.c decides when each happens. RULE: no pico-sdk or lwIP header here -- it is compiled into every
// host test.
#include <stdbool.h>
#include <stdint.h>

#define AR_RID_MAX 40                 // the server's request id: 1-40 of [A-Za-z0-9_-]
#define AR_MAX 8                      // = the server's fetch limit (remote-requests.ts takeWaiting)
#define AR_FETCH_BYTES 8192           // held lines plus a fetch merged after them (final review I2; PSRAM)
#define AR_REFETCH_ROOM (AR_MAX * 320) // a fetch needs this much free: 8 lines of "GET <40> 255:<255>\n" are 2440
#define AR_BODY_BYTES 32768           // one piece's JSON body (= DC_POST_BODY_MAX, plan ruling F2)
#define AR_PIECE_LINES 400            // = the server's lines.max(400)
#define AR_LINE_MAX 640               // = AS_LINE_MAX and the server's z.string().max(640)
#define AR_TAG_MAX 9                  // Transfer's tag: 1-9 decimal digits
#define AR_ERR_MAX 200                // "ERR <40> <code> <len>:<text>": Transfer's text is at most 79
#define AR_LATE_BYTES 1280            // a late ERR's whole body: AR_ERR_MAX escaped (x6) plus the frame

typedef enum { AR_NONE = 0, AR_VOLS, AR_DIR, AR_GET } ar_kind_t;

// A GET Transfer answered GOT: its file comes up later as an upload with this tag. err_owed: the GET failed after its
// GOT (Transfer's late ERR, the upload refused, the connection lost); `err` is the line to post as piece 1.
typedef struct ar_got {
    bool used, err_owed;
    uint32_t seq;                     // when it was added: the oldest goes when the table is full (plan ruling F13)
    char rid[AR_RID_MAX + 1];
    char tag[AR_TAG_MAX + 1];
    char err[AR_ERR_MAX + 1];
} ar_got_t;

// The board's request state. The caller's, in PSRAM on the board (main.c), like as_up_t.
typedef struct as_req {
    uint32_t want_v, have_v;          // the poll's req.v, and the v acked (the one seen before the last fetch)
    char fetched[AR_FETCH_BYTES + 1]; // request lines not yet taken, from the start: a taken line is cut out
    int fetched_len;
    // The request being answered (taken from `fetched`): sent to Transfer, or answered by the board itself.
    bool active, sent, ended, discard;   // ended: its last line is in; discard: the server refused a piece (F6)
    ar_kind_t kind;
    char rid[AR_RID_MAX + 1];
    char out[AR_LINE_MAX + 8];        // its line as it goes to Transfer, '\n'-terminated
    int out_n;
    uint32_t t_last;                  // it went out, or its last answer line came
    uint32_t lines_total;
    // The piece being gathered: {"piece":N,"lines":["..",..  then  ],"last":B} once closed.
    char body[AR_BODY_BYTES];
    int body_len, body_lines;
    uint32_t piece;
    bool post_owed, post_last;        // closed, waiting for its POST
    char end_err[AR_ERR_MAX + 1];     // an ERR that ends the answer once the piece in flight is posted
    ar_got_t got[AR_MAX];
    uint32_t got_seq;
    char late[AR_LATE_BYTES];         // a late ERR's body, built when it is posted
    bool browse;                      // READY 3's flag: Transfer's switch, for the poll
    // amiga_send.c's own flags, here so that SRAM does not grow (final review):
    bool quick;                       // a protocol 3 drop: the reconnect in AS_RETRY_WAITING_MS counts as work (I1)
    bool refetched;                   // fetched since the last request was taken: the next GET goes without (I2)
    bool ping_held;                   // lines were held for a piece: the PONG deadline restarts when they are not (M2)
} as_req_t;

void ar_init(as_req_t *r);
// Before a fetch: the bytes free after the held lines (which end in a newline). Fetch into r->fetched + fetched_len.
int ar_fetch_room(as_req_t *r);
// n bytes were fetched into r->fetched + fetched_len: kept after the held lines, to be taken line by line.
void ar_fetched(as_req_t *r, int n);
bool ar_pending(const as_req_t *r);   // a fetched line waits to be taken
bool ar_only_gets(const as_req_t *r); // lines are held, and every one is a GET
// Takes the next valid request line: active, kind, rid and out set, piece 0 begun. Malformed lines are skipped (and
// counted in *skipped when it is not NULL). False when none is left.
bool ar_take(as_req_t *r, int *skipped);
// The answer's piece. add: false when the line does not fit (never after !ar_body_full). full: a line of AR_LINE_MAX
// bytes might not fit. close: ends the JSON and marks it owed.
void ar_body_begin(as_req_t *r);
bool ar_body_add(as_req_t *r, const char *line);
bool ar_body_full(const as_req_t *r);
void ar_body_close(as_req_t *r, bool last);
// A piece was posted: the next piece begins (carrying end_err if one waits), or, after the last, the request ends.
void ar_body_posted(as_req_t *r);
// Ends the active answer with the board's own "ERR <rid> <code> <len>:<text>". No-op once ended; with discard set
// the request just finishes (nothing more is posted for it).
void ar_end_err(as_req_t *r, const char *code, const char *text);
void ar_finish(as_req_t *r);          // the request is done with: nothing more is posted for it
// "ERR <rid> <code> <len>:<text>" into out[cap]; the text is cut to 79 characters. Length, or -1.
int ar_err_line(char *out, int cap, const char *rid, const char *code, const char *text);
// A line from Transfer: its verb (VOL, ENT, DONE, ERR or GOT) and rid. False for any other line.
bool ar_line_verb(const char *line, char verb[5], char rid[AR_RID_MAX + 1]);
// The GOT table.
ar_got_t *ar_got_add(as_req_t *r, const char *rid, const char *tag);   // the oldest entry goes when it is full
ar_got_t *ar_got_by_tag(as_req_t *r, const char *tag);
ar_got_t *ar_got_by_rid(as_req_t *r, const char *rid);
void ar_got_fail(ar_got_t *g, const char *code, const char *text);    // once: a later failure keeps the first
void ar_got_late(ar_got_t *g, const char *line);                      // Transfer's own late ERR line, as it came
ar_got_t *ar_got_owed(const as_req_t *r);                             // the first entry whose ERR waits
int ar_late_body(as_req_t *r, const ar_got_t *g);                     // r->late = {"piece":1,"lines":[err],"last":true}
void ar_got_remove(ar_got_t *g);

#endif
