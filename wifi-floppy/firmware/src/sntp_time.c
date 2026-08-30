// Blocking wrapper around lwIP's SNTP client. Device-only (lwIP, cyw43);
// excluded from the host build by test/run.sh, same as transport_tls.c.
//
// lwIP's sntp.c has no "give me the time and call me back" API -- it calls
// the SNTP_SET_SYSTEM_TIME(sec) macro (defined in lwipopts.h to
// sntp_time_apply(), below) from inside its own UDP receive processing
// whenever a reply validates. So "blocking" here means the same busy-wait
// pattern http_fetch.c already uses for its TCP fetch: lwIP's callbacks
// run on the cyw43_arch_lwip_threadsafe_background low-priority IRQ
// context while this thread just polls a flag and sleep_ms()s.
#include "sntp_time.h"
#include "lwip/apps/sntp.h"
#include "pico/cyw43_arch.h"
#include "pico/time.h"
#include <sys/time.h>

static volatile bool g_time_valid;
static bool g_started;

// Called from lwipopts.h's SNTP_SET_SYSTEM_TIME(sec) macro, i.e. from
// inside lwIP's own processing context. sec is already a Unix-epoch second
// count (sntp.c applies the NTP-vs-Unix epoch offset before invoking this).
void sntp_time_apply(uint32_t unix_sec) {
    struct timeval tv = { .tv_sec = (time_t)unix_sec, .tv_usec = 0 };
    settimeofday(&tv, NULL);   // pico_clib_interface's weak newlib hook;
                               // time()/mbedtls_time() read this back.
    g_time_valid = true;
}

bool sntp_time_valid(void) {
    return g_time_valid;
}

bool sntp_sync_blocking(uint32_t timeout_ms) {
    if (g_time_valid) return true;

    if (!g_started) {
        cyw43_arch_lwip_begin();
        sntp_setoperatingmode(SNTP_OPMODE_POLL);
        // A fixed, well-known pool rather than DHCP-supplied servers: most
        // home/office routers don't hand out option 42, and a device that
        // silently never syncs because of that would stay diskless forever
        // for a reason nobody could see from the LAN side.
        sntp_setservername(0, "pool.ntp.org");
        sntp_init();
        cyw43_arch_lwip_end();
        g_started = true;
    }

    absolute_time_t deadline = make_timeout_time_ms(timeout_ms);
    while (!g_time_valid &&
           absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
        sleep_ms(1);
    }
    return g_time_valid;
}
