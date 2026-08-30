#ifndef LWIPOPTS_H
#define LWIPOPTS_H
#define NO_SYS                      1
#define LWIP_SOCKET                 0
#define LWIP_NETCONN                0
#define MEM_ALIGNMENT               4
#define MEM_SIZE                    16384
// (Not MEM_LIBC_MALLOC: pico_cyw43_arch_threadsafe_background.c #errors on
// that combination outright -- lwIP's mem_malloc can run from the
// low-priority IRQ context this arch mode uses, and newlib malloc isn't
// safe to call from there. This only governs lwIP's own small internal
// allocations (e.g. altcp's per-connection wrapper struct) -- the ~16 KB
// in/out TLS record buffers mbedtls_ssl_setup() allocates are separate
// mbedtls_calloc() calls that land on the ordinary C heap, not here.)
#define MEMP_NUM_TCP_SEG            32
#define PBUF_POOL_SIZE              24
#define LWIP_ARP                    1
#define LWIP_ICMP                   1
#define LWIP_DHCP                   1
#define LWIP_DNS                    1
#define LWIP_TCP                    1
#define TCP_WND                     (8 * TCP_MSS)
#define TCP_MSS                     1460
#define TCP_SND_BUF                 (8 * TCP_MSS)
#define LWIP_NETIF_STATUS_CALLBACK  1
#define LWIP_NETIF_LINK_CALLBACK    1
#define LWIP_NETIF_HOSTNAME         1
#define LWIP_TIMEVAL_PRIVATE        0
#define SYS_LIGHTWEIGHT_PROT        1

// --- TLS (task 9): altcp's layered TCP/TLS API, backed by mbedTLS -------
#define LWIP_ALTCP                  1
#define LWIP_ALTCP_TLS              1
#define LWIP_ALTCP_TLS_MBEDTLS      1
// ALTCP_MBEDTLS_AUTHMODE is deliberately NOT set here -- see
// src/tls_guard.h and CMakeLists.txt's target_compile_definitions. Setting
// it in this header would make WFMF_OMIT_AUTHMODE's guard-fires proof
// (task-9-brief.md Step 3) meaningless, since the omitted CMake define
// would still be shadowed by this one.

// --- SNTP (task 9): wall clock for certificate expiry checking ----------
// A fixed pool hostname, not DHCP option 42 (LWIP_DHCP_MAX_NTP_SERVERS):
// most home/office routers never hand out NTP servers over DHCP, and a
// device that silently never syncs because of that would stay diskless for
// a reason invisible from the LAN side. SNTP_SERVER_DNS=1 is what makes
// sntp_setservername() (see sntp_time.c) accept a hostname instead of only
// a resolved ip_addr_t.
#define SNTP_SERVER_DNS             1
// The library's default start-up jitter (up to 5 s, meant to keep a fleet
// of devices from hammering one server at once) only adds latency here:
// sntp_sync_blocking()'s caller already owns its own timeout/backoff (see
// device_client.c), so let it sync as soon as the network is up.
#define SNTP_STARTUP_DELAY          0
// sntp.c calls this macro (not a callback) with a Unix-epoch second count
// once a reply validates. sntp_time_apply() (sntp_time.c) applies it via
// settimeofday() and flips sntp_time_valid(). Forward-declared here rather
// than pulling in sntp_time.h's full contract, since this header is
// included by every lwIP translation unit, not just sntp.c.
#include <stdint.h>
void sntp_time_apply(uint32_t unix_sec);
#define SNTP_SET_SYSTEM_TIME(sec)   sntp_time_apply(sec)
#endif
