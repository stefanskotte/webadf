#ifndef CONFIG_STORE_H
#define CONFIG_STORE_H
// Persists the credentials the captive portal collects -- the home WiFi's
// SSID/passphrase and the device's pairing code -- across power cycles.
// Plan 4a compiled these into the image; plan 4b's portal writes them here
// instead. See token_store.h for the sibling store this one is modelled on
// (same flash-sector-behind-a-magic-word approach) and this file's .c for
// the one thing that differs: a CRC over the payload.
//
// Host build (WFMF_HOST_TEST): a static in-process buffer.
// Device build: a dedicated flash sector via hardware/flash.h, written
// with pico/flash.h's flash_safe_execute, immediately below the sector
// token_store.c owns (that one claims the very top of flash; this one
// claims the sector below it, so the two never collide).
#include <stdbool.h>

#define CONFIG_SSID_MAX 32     // 802.11 limit
#define CONFIG_PASS_MAX 63     // WPA2 passphrase limit
#define CONFIG_CODE_MAX 16     // pairing codes are 6; headroom

typedef struct {
    char ssid[CONFIG_SSID_MAX + 1];
    char pass[CONFIG_PASS_MAX + 1];
    char code[CONFIG_CODE_MAX + 1];
} device_config_t;

// False if nothing valid is stored (erased sector, bad magic, or CRC
// mismatch). A CRC mismatch means a write that completed the magic but
// left a corrupted payload -- e.g. power lost partway through flashing a
// page that had already made it past the magic bytes. token_store's magic
// alone cannot catch that case (see token_store.c's header comment); this
// store's CRC exists specifically because credentials are written at the
// end of an interactive portal flow, exactly the moment someone is most
// likely to walk away and pull the power.
bool config_store_load(device_config_t *out);

// False on over-length fields or while a disk is mounted (same guard as
// token_store_save() -- see its comment for why). Erases the token on
// success: re-pairing issues a new device row and a new token server-side,
// and keeping the old token around would leave the board authenticating as
// a device the server no longer associates with these credentials.
bool config_store_save(const device_config_t *cfg);

// Clears credentials AND the token. Same mounted-disk guard.
void config_store_erase(void);

// Host tests only (declared unconditionally, like token_store.h's
// simulate-torn-write above it): never called on device.
//
// Simulates a flash program that started but was interrupted before it
// finished (e.g. power loss mid-write): the page ends up holding neither
// the erased pattern nor a valid magic+payload.
void config_store_test_simulate_torn_write(void);
// Simulates a flash program that finished -- magic intact -- but whose
// payload was subsequently damaged (e.g. a bit flip, or a torn write that
// happened to land after the magic bytes were already programmed). This is
// the case token_store cannot detect and this store's CRC exists to catch.
void config_store_test_corrupt_payload_byte(void);

#endif
