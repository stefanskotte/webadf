#ifndef HTTP_FETCH_H
#define HTTP_FETCH_H
#include <stdint.h>
#include <stdbool.h>
#include "floppy_io.h"

// Streaming GET. The sink is called with body bytes as they arrive, so a
// multi-megabyte image can be written straight into PSRAM without ever
// needing an SRAM buffer that big. Return value: body bytes, or <0.
typedef void (*http_sink_fn)(void *ctx, const uint8_t *data, int len);
int http_get_stream(const char *path, http_sink_fn sink, void *ctx,
                    int idle_timeout_ms);

// Write-back path (still a skeleton).
int http_post_track(int track, const uint8_t *mfm, int len);
#endif
