#ifndef CLOCK_H
#define CLOCK_H
#include <exec/types.h>
/* Seconds since 1978 from the system clock (DateStamp): enough to time a silence or a 60 s wait. The one copy, used by
   net.c, shell.c and gui.c (plan ruling PF6). */
ULONG rx_now_secs(void);
#endif
