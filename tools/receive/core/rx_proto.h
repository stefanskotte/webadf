#ifndef RX_PROTO_H
#define RX_PROTO_H
#include "rx_names.h"

#define RX_PORT 6800
#define RX_ID_MAX 40
#define RX_LIST_MAX 32
#define RX_LINE_MAX 640
#define RX_OUT_MAX 1024
#define RX_FILE_MAX 4194304UL
#define RX_COMMENT_MAX 79
#define RX_TMP_NAME ".webadf-rx"
#define RX_IDLE_SECS 75   /* a connection silent this long is dropped: the board pings every 30 s */
/* Protocol 2 (spec 2026-10-18 §3): files go up to the web app over the same connection. */
#define RX_KEY_HEX 32            /* the board key in the hello: 32 hex digits (spec §6) */
#define RX_UP_MAX 64             /* files waiting to go up; a drop adds at most this many (spec §2) */
#define RX_LOCAL_MAX 255         /* an Amiga path to read, such as DH0:Work/foo.lha */
#define RX_UP_BLOCK 8192UL       /* files are read in 8 KB blocks (spec §2) */
#define RX_UP_IDLE_SECS 360      /* the silence allowed while a file goes up: past the board's 5-minute wait (Transfer 2.2) */
#define RX_TREE_DEPTH 16         /* drawers inside a dropped drawer, at most */
/* Protocol 3 (spec 2026-10-30 §2): the web app browses the Amiga's volumes, read-only. */
#define RX_VOLS_MAX 32           /* volumes in one VOLS answer; more are left out */
#define RX_NAME_RAW 108          /* a name as AmigaDOS gives it (fib_FileName); only names of 30 bytes or less are sent */
#define RX_ENT_MAX 1000          /* a DIR answer stops here with "cut" (spec §2.2) */
#define RX_REQ_LINE 256          /* the longest answer line: an ENT with a 40-byte id and a 79-byte comment is 217 */
#define RX_REQ_ROOM (RX_REQ_LINE + 128)   /* a request writes its next line only with this much room left: the rest
                                             is for a PONG, GO, OK or refusal that arrives meanwhile (put() drops
                                             what does not fit) */
/* AmigaDOS error numbers (dos/dos.h), for the core's choice of protocol code (plan ruling T3). */
#define RX_DOS_IN_USE 202
#define RX_DOS_DIR_NOT_FOUND 204
#define RX_DOS_NOT_FOUND 205
#define RX_DOS_WRONG_TYPE 212
#define RX_DOS_READ_PROTECTED 224
#define RX_DOS_NO_DISK 226

typedef struct rx_finfo {        /* what Examine says about a file that goes up */
    unsigned long size, prot, days, mins, ticks;
    char comment[RX_COMMENT_MAX + 1];
} rx_finfo;
typedef struct rx_vol {          /* a mounted volume */
    char name[RX_NAME_RAW], device[RX_NAME_RAW];   /* "Work", "DH0:" */
    unsigned long size, free, days, mins, ticks;   /* bytes (0: unknown); the volume's date */
} rx_vol;
typedef struct rx_dent {         /* one entry of a drawer */
    int is_dir; unsigned long size, prot, days, mins, ticks;
    char name[RX_NAME_RAW]; char comment[RX_COMMENT_MAX + 1];
} rx_dent;
typedef void (*rx_list_fn)(void *u, const char *name, int is_dir);

typedef struct rx_fs {
    void *ctx;
    int (*folder_ok)(void *ctx);                    /* 1 if the target folder exists and is a folder */
    unsigned long (*free_bytes)(void *ctx);         /* free bytes on its volume; 0xFFFFFFFF if unknown or more */
    int (*exists)(void *ctx, const char *rel);      /* 1 if rel exists (file or folder) */
    int (*make_dir)(void *ctx, const char *rel);    /* 0 if rel is now a folder */
    int (*open_w)(void *ctx, const char *rel);      /* 0 ok; creates or truncates; one file at a time */
    int (*write)(void *ctx, const unsigned char *b, unsigned long n); /* 0 ok */
    int (*close_w)(void *ctx);                      /* 0 ok */
    int (*rename)(void *ctx, const char *from, const char *to);       /* 0 ok */
    int (*remove)(void *ctx, const char *rel);      /* 0 ok */
    int (*set_meta)(void *ctx, const char *rel, unsigned long prot, const char *comment); /* 0 ok */
    /* Protocol 2: files that go up. These paths are the Amiga's own (DH0:x/y), not under the folder. */
    int (*is_dir)(void *ctx, const char *local);                         /* 1 a drawer, 0 a file, -1 neither */
    int (*list)(void *ctx, const char *local, rx_list_fn each, void *u); /* 0: each entry of the drawer */
    int (*open_r)(void *ctx, const char *local, rx_finfo *info);         /* 0: open (shared) for reading, info filled */
    long (*read)(void *ctx, unsigned char *b, unsigned long n);          /* bytes read (< n only at the end), -1 failed */
    void (*close_r)(void *ctx);
    /* Protocol 3 (spec 2026-10-30 §2.2): browsing, read-only, with shared locks. Errors are AmigaDOS error numbers. */
    int (*vols)(void *ctx, rx_vol *out, int max);      /* the mounted volumes, at most max; -1 failed */
    long (*dir_open)(void *ctx, const char *path);     /* 0, or a DOS error (RX_DOS_WRONG_TYPE: not a drawer) */
    long (*dir_next)(void *ctx, rx_dent *e);           /* 1 an entry, 0 the end, -<DOS error> failed */
    void (*dir_close)(void *ctx);                      /* the drawer's lock released */
    long (*stat)(void *ctx, const char *path, rx_finfo *info, int *is_dir);   /* 0, or a DOS error */
    void (*fault)(void *ctx, long err, char *text, unsigned cap);             /* AmigaDOS's words for err */
} rx_fs;

enum { RX_EV_HELLO, RX_EV_LIST, RX_EV_BEGIN, RX_EV_PROGRESS, RX_EV_DONE, RX_EV_FAILED,
       RX_EV_TRUST,          /* after HELLO, with a queue attached: code "new" (store key now), "ok", "other", "old" */
       RX_EV_UP_BEGIN,       /* the board took the file: bytes = where it resumes */
       RX_EV_UP_PROGRESS,    /* bytes = stored on the web app (MORE's <stored> field) */
       RX_EV_UP_DONE,        /* path = the name as stored */
       RX_EV_UP_FAILED,      /* text = why; code = the board's NO code, or "local" */
       RX_EV_REQ };          /* a web request answered (protocol 3): id = its id, code "vols"|"dir"|"get", path (vols:
                                ""), size = entries sent, bytes = 1 if cut, text = NULL, or why it was refused */
enum { RX_REQ_NONE, RX_REQ_VOLS, RX_REQ_DIR, RX_REQ_GET };
typedef struct rx_event {
    int kind;
    const char *id;       /* BEGIN, PROGRESS, DONE, FAILED */
    const char *path;     /* BEGIN, FAILED: as sent; DONE: as saved; UP_*: the name sent (UP_DONE: as stored) */
    unsigned long size;   /* BEGIN, PROGRESS, DONE, UP_* */
    unsigned long bytes;  /* PROGRESS, UP_BEGIN, UP_PROGRESS */
    const char *text;     /* FAILED, UP_FAILED: the reason, e.g. "checksum mismatch" */
    unsigned tag;         /* UP_*: the item */
    const char *code;     /* TRUST, UP_FAILED */
    const char *key;      /* TRUST: the board's key ("" when it sent none) */
} rx_event;
typedef void (*rx_event_fn)(void *uctx, const rx_event *ev);

typedef struct rx_item { char id[RX_ID_MAX + 1]; unsigned long size; char path[RX_PATH_MAX + 1]; } rx_item;

typedef struct rx_up_item {
    unsigned tag; char local[RX_LOCAL_MAX + 1]; char name[RX_PATH_MAX + 1];
    char rid[RX_ID_MAX + 1];   /* a GET's request id (spec 2026-10-30 §2.2), "" for the owner's own files */
} rx_up_item;
/* The files waiting to go up, and the trusted board key: the front end's, outliving every connection. */
typedef struct rx_upq {
    rx_up_item q[RX_UP_MAX]; unsigned n, next_tag;
    char trusted[RX_KEY_HEX + 1];   /* "" until the first board: trust on first use */
    int trust_next;                 /* TRUST before the board connected: its key replaces the saved one */
    int browse;                     /* 1: the owner lets the web app browse (ENVARC:webadf/Browse; spec 2026-10-30 §2.3) */
} rx_upq;
enum { RX_TRUST_NONE, RX_TRUST_OK, RX_TRUST_OTHER, RX_TRUST_OLD };
enum { RX_UP_IDLE, RX_UP_ASKED, RX_UP_SKIP, RX_UP_DATA, RX_UP_ENDED };   /* PUT out; CRC over the resumed part; bytes; END out */

typedef struct rx_session { /* fields private to rx_proto.c except list/list_n */
    const rx_fs *fs; rx_event_fn on_event; void *uctx;
    int in_data;
    char line[RX_LINE_MAX + 1]; unsigned line_n;
    rx_item list[RX_LIST_MAX]; unsigned list_n, list_expect, list_seen;
    char cur_id[RX_ID_MAX + 1], cur_path[RX_PATH_MAX + 1], cur_comment[RX_COMMENT_MAX + 1];
    char cur_tmp[RX_PATH_MAX + sizeof RX_TMP_NAME];   /* the path's folder (< 255 bytes) + the temp name */
    unsigned long cur_size, cur_left, cur_crc_want, cur_crc, cur_prot, cur_mark;
    int cur_open, cur_write_failed;
    char out[RX_OUT_MAX]; unsigned out_n;
    /* protocol 2 */
    rx_upq *upq; int peer_v, trust, proto_err; char peer_key[RX_KEY_HEX + 1];
    int up_phase, up_closing, up_cancel; rx_up_item up_cur; rx_finfo up_info;
    unsigned long up_off, up_credit, up_stored, up_sent, up_skip, up_crc;
    /* protocol 3 */
    int hello_browse;                                   /* what READY 3 said */
    int req_kind, req_open, req_nvols; unsigned req_i, req_count;
    char req_id[RX_ID_MAX + 1], req_path[RX_LOCAL_MAX + 1];             /* the request being answered */
    int wait_kind; char wait_id[RX_ID_MAX + 1], wait_path[RX_LOCAL_MAX + 1];   /* the one request waiting */
    rx_vol req_vols[RX_VOLS_MAX];
} rx_session;

void rx_init(rx_session *s, const rx_fs *fs, rx_event_fn on_event, void *uctx);
int rx_feed(rx_session *s, const unsigned char *data, unsigned long n); /* 0, or -1: close the connection */
/* Moves what is to be sent now into dst: reply lines, a PUT, or file bytes within the board's credit (one 8 KB block
   at most). 0: nothing this time (perhaps a block read only for the CRC: ask rx_want_output). -1: close the
   connection now (an upload stopped mid-file, or the board broke the protocol). */
int rx_take_output(rx_session *s, char *dst, unsigned cap);
int rx_want_output(const rx_session *s);   /* 1 while rx_take_output has work now */
/* Stop an upload: a waiting file leaves the list (0); the file going up sends ABORT before TAKE (0), or -- once bytes
   flow -- needs the connection closed (1; rx_take_output then returns -1). -1: no such tag. */
int rx_up_cancel(rx_session *s, rx_upq *q, unsigned tag);
int rx_idle_secs(const rx_session *s);     /* the silence allowed: RX_IDLE_SECS, RX_UP_IDLE_SECS while a file goes up */
/* 1 while Receive CRCs the part of a resumed file the web app already has: no byte goes either way meanwhile, and on a
   68000 it can take minutes (the board allows for it, AS_UP_PREREAD_MS). The silence is Receive's own work, so the
   loop restarts its idle clock while this is 1. */
int rx_up_reading_ahead(const rx_session *s);
void rx_disconnected(rx_session *s);   /* the peer went away: drop a half-written file */
int rx_busy(const rx_session *s);      /* 1 while a file is being received */

/* Protocol 2 (spec 2026-10-18). */
void rx_upq_init(rx_upq *q, const char *trusted);              /* trusted: ENVARC:webadf/BoardKey, or "" */
unsigned rx_up_add(rx_upq *q, const char *local, const char *name);  /* tag, or 0: full, or a bad name */
/* A GET's file (spec 2026-10-30 §2.2): first in the queue; rid ties its PUT to the request. Tag, or 0. */
unsigned rx_up_add_front(rx_upq *q, const char *local, const char *name, const char *rid);
int rx_upq_remove(rx_upq *q, unsigned tag);                    /* 1 removed */
typedef void (*rx_added_fn)(void *u, const rx_up_item *it);
/* A file, or a drawer walked (64 files at most, .info files skipped, sub-paths kept); files added, or -1. */
int rx_up_add_tree(rx_upq *q, const rx_fs *fs, const char *local, const char *name, rx_added_fn added, void *u);
void rx_attach(rx_session *s, rx_upq *q);   /* after rx_init: this connection may upload from q */
int rx_uploads_on(const rx_session *s);     /* 1: a protocol 2 board with the trusted key */
int rx_trust_now(rx_session *s);            /* TRUST: the connected board's key becomes the saved one; -1 none */
void rx_key4(const char *key, char out[5]); /* its first 4 digits, upper case, as the window and the web app show */
/* Protocol 3 (spec 2026-10-30). */
int rx_browse_on(const rx_session *s);    /* 1: requests are answered (switch on, protocol 3, the trusted key) */
/* 1 when READY 3's flag no longer matches the switch (or the trust) and the connection is idle: the front end closes
   it, so the board reconnects and hears the new flag (plan ruling T1). */
int rx_hello_stale(const rx_session *s);
/* The protocol code for an AmigaDOS error (plan ruling T3); want_dir: the request wanted a drawer (DIR), not a file. */
const char *rx_err_code(long err, int want_dir);
/* An RX_EV_REQ in the owner's words (spec §2.3): "listed volumes", "listed Work:Programs", "copied Work:a.lha",
   "could not list Work:x: <why>"; a path over 40 bytes ends "...". Cut to cap. */
void rx_req_words(const rx_event *e, char *out, unsigned cap);

#endif
