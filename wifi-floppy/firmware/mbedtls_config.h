#ifndef MBEDTLS_CONFIG_H
#define MBEDTLS_CONFIG_H
// Minimal mbedTLS 3.6 config for a single-purpose TLS 1.2/1.3 *client*,
// verifying a server certificate against tools/gen_roots.sh's pinned root
// bundle. No server side, no DTLS, no PSK/session resumption -- the device
// makes short-lived outbound connections to one host (WEBADF_HOST) and
// nothing else needs to be in the image.
//
// Verified empirically against the live host before picking curves/suites
// (see task-9-report.md): TLSv1.3, TLS_AES_128_GCM_SHA256, and -groups
// P-256 alone (no X25519/PQC hybrid) still negotiates and verifies cleanly
// on both TLS 1.2 and TLS 1.3, so secp256r1 is the only curve enabled here.
// The chain (leaf/WR1/GTS Root R1) is RSA-2048/4096, sha256WithRSAEncryption,
// so RSA + PKCS1 v1.5/v2.1 (PSS, which TLS 1.3 requires for RSA signatures)
// are both enabled.

// --- Platform / time -------------------------------------------------
// MBEDTLS_HAVE_TIME_DATE is what certificate expiry checking needs; it in
// turn needs a working time() -- see sntp_time.c, which calls
// settimeofday() (pico_clib_interface's weak newlib hook) once synced.
// transport_tls.c's connect() refuses to even start a handshake while
// sntp_time_valid() is false, so mbedtls_time() is never consulted with a
// bogus post-boot-epoch clock.
#define MBEDTLS_HAVE_TIME
#define MBEDTLS_HAVE_TIME_DATE
#define MBEDTLS_PLATFORM_C
// mbedtls's default mbedtls_ms_time() (platform_util.c) only has bodies for
// POSIX (_POSIX_VERSION) and Win32 -- bare metal is neither, and it
// #errors ("No mbedtls_ms_time available") rather than silently doing
// nothing. MBEDTLS_PLATFORM_MS_TIME_ALT hands that job to our own
// mbedtls_ms_time() (transport_tls.c), built on pico/time.h's
// to_ms_since_boot(get_absolute_time()) -- a monotonic ms counter, which is
// all this is used for (handshake/session-ticket timing, not wall time).
#define MBEDTLS_PLATFORM_MS_TIME_ALT

// --- Entropy / RNG -----------------------------------------------------
// pico_mbedtls.c (linked in by the pico_mbedtls CMake target) implements
// mbedtls_hardware_poll() using the RP2350's hardware RNG (get_rand_64()).
// MBEDTLS_NO_PLATFORM_ENTROPY turns off mbedtls's own attempt to read a
// platform entropy source (/dev/urandom and friends) that doesn't exist on
// bare metal.
#define MBEDTLS_ENTROPY_HARDWARE_ALT
#define MBEDTLS_NO_PLATFORM_ENTROPY
#define MBEDTLS_ENTROPY_C
#define MBEDTLS_CTR_DRBG_C

// --- Symmetric / hash ----------------------------------------------------
#define MBEDTLS_CIPHER_C
#define MBEDTLS_AES_C
#define MBEDTLS_GCM_C
#define MBEDTLS_MD_C
#define MBEDTLS_SHA256_C
// SHA-384/512 is needed to PARSE a trust anchor, not to verify anything on
// this chain. The comment at the top of this file reasoned from the SERVED
// chain -- leaf, WR1 and GTS Root R1 are all sha256WithRSAEncryption, which
// is true -- and concluded SHA-256 was sufficient. It is not: GTS Root R1's
// own SELF-signature is sha384WithRSAEncryption, and mbedtls_x509_crt_parse()
// rejects a certificate whose signature algorithm it cannot name, whether or
// not that signature is ever checked. A rejected root simply never enters the
// trust store.
//
// That mattered far more than one missing root, because lwIP's
// altcp_tls_create_config() fails the WHOLE config on any non-zero return
// from mbedtls_x509_crt_parse() (altcp_tls_mbedtls.c) -- and that function is
// permissive, returning the COUNT of certs it rejected rather than an error.
// So two unparseable roots in a five-root bundle produced a flat NULL, no
// TLS config at all, and every request failing before a single packet moved.
// Measured on a rev A2 board 2026-09-10: `tls: root CA parse -> 2`.
#define MBEDTLS_SHA512_C           // provides SHA-384; SHA384_C requires it
#define MBEDTLS_SHA384_C
#define MBEDTLS_HKDF_C            // TLS 1.3 key schedule (also drives the
                                   // PSA_WANT_ALG_HKDF_* auto-derivation
                                   // check_config.h requires for TLS 1.3).

// --- PSA crypto (legacy-config-driven, not MBEDTLS_PSA_CRYPTO_CONFIG) ---
// mbedtls 3.x's TLS 1.3 code path is written against the PSA API for its
// HKDF/hash operations. Enabling MBEDTLS_PSA_CRYPTO_C alone (without also
// defining MBEDTLS_PSA_CRYPTO_CONFIG) makes config_adjust_psa_from_legacy.h
// synthesize the PSA_WANT_* macros it needs from the classic MBEDTLS_*_C
// macros above/below -- no separate crypto_config.h required.
#define MBEDTLS_PSA_CRYPTO_C

// --- Public key / bignum / curves --------------------------------------
#define MBEDTLS_BIGNUM_C
#define MBEDTLS_OID_C
#define MBEDTLS_ASN1_PARSE_C
#define MBEDTLS_PK_C
#define MBEDTLS_PK_PARSE_C
#define MBEDTLS_RSA_C
#define MBEDTLS_PKCS1_V15
#define MBEDTLS_PKCS1_V21          // RSA-PSS -- TLS 1.3 signs with
                                   // rsa_pss_rsae_sha256 for RSA certs.
#define MBEDTLS_ECP_C
#define MBEDTLS_ECP_DP_SECP256R1_ENABLED
#define MBEDTLS_ECDH_C
#define MBEDTLS_ECDSA_C            // Not needed by *this* chain (RSA
                                   // throughout), but cheap and keeps an
                                   // ECDSA-issued host from being a
                                   // surprise later.

// --- X.509 ---------------------------------------------------------------
#define MBEDTLS_X509_USE_C
#define MBEDTLS_X509_CRT_PARSE_C
#define MBEDTLS_X509_RSASSA_PSS_SUPPORT
#define MBEDTLS_PEM_PARSE_C        // roots.h ships PEM, not DER.
#define MBEDTLS_BASE64_C

// --- TLS -------------------------------------------------------------
#define MBEDTLS_SSL_TLS_C
#define MBEDTLS_SSL_CLI_C
#define MBEDTLS_SSL_PROTO_TLS1_2
#define MBEDTLS_SSL_PROTO_TLS1_3
#define MBEDTLS_SSL_TLS1_3_COMPATIBILITY_MODE   // middlebox interop
#define MBEDTLS_SSL_TLS1_3_KEY_EXCHANGE_MODE_EPHEMERAL_ENABLED
#define MBEDTLS_SSL_KEEP_PEER_CERTIFICATE        // required by TLS 1.3
#define MBEDTLS_SSL_SERVER_NAME_INDICATION       // transport_tls.c calls
                                                  // mbedtls_ssl_set_hostname()
#define MBEDTLS_KEY_EXCHANGE_ECDHE_RSA_ENABLED   // TLS 1.2, RSA leaf (this host)
#define MBEDTLS_KEY_EXCHANGE_ECDHE_ECDSA_ENABLED // TLS 1.2, ECDSA leaf (other hosts)

// Deliberately no #include "mbedtls/check_config.h" here: build_info.h (the
// header that pulls in this file via MBEDTLS_CONFIG_FILE) already includes
// it, after the config_adjust_*.h headers that derive PSA_WANT_*/
// MBEDTLS_PSA_BUILTIN_* from the classic macros above. Running the checks
// before that derivation would fire spurious errors.
#endif /* MBEDTLS_CONFIG_H */
