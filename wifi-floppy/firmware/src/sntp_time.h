#ifndef SNTP_TIME_H
#define SNTP_TIME_H
// Wall-clock time for the RP2350, which has no battery-backed RTC. Without
// this, mbedtls's certificate expiry check (MBEDTLS_HAVE_TIME_DATE) has
// nothing to check against -- time() would read back whatever the C library
// happens to think "now" is post-boot, which is not 2026 and would either
// spuriously reject every real certificate as not-yet-valid, or (worse, if
// mis-seeded) accept an expired one. transport_tls.c's connect() refuses to
// start a handshake at all while sntp_time_valid() is false; see
// task-9-brief.md: staying diskless beats skipping expiry validation.
#include <stdbool.h>
#include <stdint.h>

// Starts (once) the SNTP client and blocks up to timeout_ms for the first
// successful sync. A second and later call, once already synced, returns
// true immediately without blocking -- the client keeps periodically
// resyncing in the background (see SNTP_UPDATE_DELAY in lwipopts.h) for as
// long as the process runs.
bool sntp_sync_blocking(uint32_t timeout_ms);

// True once the system clock has been set from at least one successful
// SNTP reply.
bool sntp_time_valid(void);

#endif
