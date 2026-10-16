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
} rx_fs;

enum { RX_EV_HELLO, RX_EV_LIST, RX_EV_BEGIN, RX_EV_PROGRESS, RX_EV_DONE, RX_EV_FAILED };
typedef struct rx_event {
    int kind;
    const char *id;       /* BEGIN, PROGRESS, DONE, FAILED */
    const char *path;     /* BEGIN, FAILED: as sent; DONE: as saved */
    unsigned long size;   /* BEGIN, PROGRESS, DONE */
    unsigned long bytes;  /* PROGRESS */
    const char *text;     /* FAILED: the reason, e.g. "checksum mismatch" */
} rx_event;
typedef void (*rx_event_fn)(void *uctx, const rx_event *ev);

typedef struct rx_item { char id[RX_ID_MAX + 1]; unsigned long size; char path[RX_PATH_MAX + 1]; } rx_item;

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
} rx_session;

void rx_init(rx_session *s, const rx_fs *fs, rx_event_fn on_event, void *uctx);
int rx_feed(rx_session *s, const unsigned char *data, unsigned long n); /* 0, or -1: close the connection */
unsigned rx_take_output(rx_session *s, char *dst, unsigned cap);       /* moves pending reply bytes out */
void rx_disconnected(rx_session *s);   /* the peer went away: drop a half-written file */
int rx_busy(const rx_session *s);      /* 1 while a file is being received */

#endif
