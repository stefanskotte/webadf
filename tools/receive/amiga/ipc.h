#ifndef IPC_H
#define IPC_H
/* The public port webadf.Receive (spec 2026-10-18 §2): `Receive SEND <files>` in another Shell hands each file to the
   Receive already running and waits for each one's result, sent back when the file has gone up or failed. */
#include <exec/types.h>
#include "rx_proto.h"
#define RX_PORT_NAME "webadf.Receive"
int ipc_running(void);                                         /* a Receive owns the port */
int ipc_hand_off(const rx_upq *items, int trust, int *ok);     /* client: a line per file; 0 handed over, 1 gave up
                                                                  waiting (Receive not answering), -1 not handed */
int ipc_open(void);                                            /* server: 0 when the port is ours */
ULONG ipc_sigmask(void);
void ipc_take(rx_upq *q, rx_added_fn added, int (*trust)(void *u), void *u);   /* drains the port into q */
void ipc_done(unsigned tag, int ok, unsigned long size, const char *text);    /* a file finished: answer its sender */
void ipc_close(void);                                          /* answers "Receive stopped" to all still waiting */
#endif
