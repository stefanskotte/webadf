#ifndef OVERRIDE_STORE_H
#define OVERRIDE_STORE_H
// The server override: where a self-hoster points the board instead of the
// default web app. Host, port and TLS mode, in one flash sector of its own
// (see override_store.c; modelled on config_store.c).
//
// Host build (WFMF_HOST_TEST): a static in-process buffer.
// Device build: one flash sector, written with flash_safe_execute.
//
// No mounted-disk check in here: the core0 caller checks that (a flash write
// stalls the XIP bus the disk image's neighbours run from).
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define OVERRIDE_HOST_MAX 63

typedef enum { OVR_TLS_VERIFY = 0, OVR_TLS_NOVERIFY = 1 } ovr_tls_t;

typedef struct {
    char host[OVERRIDE_HOST_MAX + 1];
    uint16_t port;
    uint8_t tls;
} server_override_t;

// False: nothing valid (erased, bad magic, bad CRC, bad field).
bool override_store_load(server_override_t *out);
// False: invalid fields or a flash error.
bool override_store_save(const server_override_t *o);
void override_store_erase(void);

// Pure helpers (both builds). `loaded`/`o` come from override_store_load.
void server_effective(bool loaded, const server_override_t *o,
                      const char *default_host, server_override_t *out);
bool server_is_custom(const server_override_t *eff, const char *default_host);
// "host" at port 443, else "host:port".
void server_host_header(const server_override_t *s, char *out, size_t cap);

// Host tests only: never called on device.
// Damages one payload byte of a saved record (the CRC must catch it).
void override_store_test_corrupt_payload_byte(void);
// Damages only the magic word of a saved record.
void override_store_test_corrupt_magic(void);

#endif
