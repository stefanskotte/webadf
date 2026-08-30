#ifndef TLS_GUARD_H
#define TLS_GUARD_H
// ALTCP_MBEDTLS_AUTHMODE defaults to MBEDTLS_SSL_VERIFY_OPTIONAL, under which
// a handshake against ANY certificate completes and returns success. That is
// functionally setInsecure() -- the upstream behaviour D5 cited as a reason
// not to use Gotek_WiFi_Dongle. It fails silently: the fetch works, the disk
// mounts, nothing logs. Hence a build break rather than a comment.
#if !defined(ALTCP_MBEDTLS_AUTHMODE)
#error "ALTCP_MBEDTLS_AUTHMODE must be set to MBEDTLS_SSL_VERIFY_REQUIRED"
#endif
#if ALTCP_MBEDTLS_AUTHMODE != MBEDTLS_SSL_VERIFY_REQUIRED
#error "ALTCP_MBEDTLS_AUTHMODE must be MBEDTLS_SSL_VERIFY_REQUIRED, not OPTIONAL/NONE"
#endif
#endif
