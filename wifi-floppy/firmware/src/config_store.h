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
// A real torn write (power lost mid-program) isn't one failure shape --
// flash programs a page front-to-back, so whatever hadn't been written
// yet when power was lost reads back at flash's erased value (0xFF), and
// everything already written reads back exactly as programmed. Which
// bytes that leaves intact depends entirely on how far the write got, so
// task 1 review round 1 (Important) split this into the two shapes that
// actually matter, rather than one helper that corrupted the magic AND
// stomped a payload byte in one shot.
//
// Review round 2: the "during magic" shape below still does NOT, on its
// own, prove the magic check specifically is what rejects it -- it also
// leaves the version byte at 0xFF (!= CONFIG_VERSION), so the version
// check catches it too, in mutation testing with the magic comparison
// itself deleted. That is correct defence-in-depth for a real interrupted
// write (several gates independently failing is fine, even desirable),
// but it means no test here pinned the magic comparison in isolation.
// config_store_test_corrupt_magic() below is the one that does that, by
// construction: a fully valid, self-consistent record with ONLY the magic
// word wrong.
//
// Interrupted before the magic word finished landing: only the first two
// of its four bytes made it out, the rest of the page -- including the
// remaining magic bytes, the version byte, the length bytes, and the
// whole payload -- is still at flash's erased value. Rejected by the
// magic check in the current code (it runs first), but defence-in-depth
// means the version check would also reject it if the magic check were
// ever removed -- this helper cannot tell those two apart, and doesn't
// need to: see config_store_test_corrupt_magic() for the helper that does.
void config_store_test_simulate_torn_write_during_magic(void);
// Interrupted after the magic word (and header) finished landing, but
// before the payload that follows it did: magic, version, and the length
// bytes are all intact and valid, but some suffix of ssid/pass/code/crc is
// still at flash's erased value. The magic check passes here -- there is
// nothing wrong with it -- so only the CRC can catch this. (Mutation-
// verified: deleting the CRC comparison alone makes the corresponding
// test fail; nothing else in the code path would have caught it.)
void config_store_test_simulate_torn_write_after_magic(void);
// Simulates a flash program that finished -- magic intact, payload fully
// written -- but whose payload was subsequently damaged (e.g. a bit flip
// well after the write completed). This is the case token_store cannot
// detect at all (its magic sits at offset 0 and nothing else is checked)
// and this store's CRC exists to catch.
void config_store_test_corrupt_payload_byte(void);
// Review round 2 (Important, still not fully addressed by the two
// torn-write helpers above): writes a fully valid, self-consistent record
// via config_store_save(), then damages ONLY the magic word -- version,
// lengths, payload, and CRC are all left exactly as written and remain
// mutually consistent with each other. This is the one helper that
// isolates the magic comparison: with everything else about the record
// correct, only the magic check can reject it, so a test built on this
// must fail if-and-only-if the magic comparison is deleted (unlike the
// during-magic torn-write case above, where the version check also fires).
void config_store_test_corrupt_magic(void);

#endif
