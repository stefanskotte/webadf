#ifndef NET_H
#define NET_H
#include <exec/types.h>
#include "afs.h"
#include "rx_proto.h"
extern struct Library *SocketBase;
int net_open(void);                 /* 0 if bsdsocket.library opened */
void net_close(void);
typedef struct net_ui {             /* the front end's hooks */
    void *u;
    void (*on_event)(void *u, const rx_event *e, rx_session *s);
    void (*on_status)(void *u, const char *text);
    ULONG extra_sigs;               /* window, AppWindow and port signals; 0 for a plain Shell */
    int (*on_signal)(void *u, ULONG sigs);            /* 1 = quit */
    int (*on_pass)(void *u, rx_session *s, int connected);   /* each pass; 1 = quit; NULL: never */
    void (*on_link)(void *u, int connected);          /* the board connected (1) or went (0); NULL: nothing */
} net_ui;
int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s, rx_upq *q); /* returns when asked to quit; 0 ok, -1 no listen */
#endif
