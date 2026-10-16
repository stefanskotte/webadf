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
    ULONG extra_sigs;               /* window port signal; 0 for the Shell */
    int (*on_signal)(void *u, ULONG sigs);  /* 1 = quit */
} net_ui;
int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s); /* returns when asked to quit; 0 ok, -1 no listen */
#endif
