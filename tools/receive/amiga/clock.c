/* See clock.h. */
#include <dos/dos.h>
#include <proto/dos.h>
#include "clock.h"

ULONG rx_now_secs(void) {
    struct DateStamp ds;
    DateStamp(&ds);
    return (ULONG)ds.ds_Days * 86400UL + (ULONG)ds.ds_Minute * 60UL + (ULONG)ds.ds_Tick / TICKS_PER_SECOND;
}
