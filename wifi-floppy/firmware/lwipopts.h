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
#define PBUF_POOL_SIZE              32   // headroom for a full-size TLS record
                                         // in flight, see TCP_WND below
#define LWIP_ARP                    1
#define LWIP_ICMP                   1
#define LWIP_DHCP                   1
#define LWIP_DNS                    1
#define LWIP_TCP                    1
// MUST EXCEED ONE MAXIMUM TLS RECORD, and 8*TCP_MSS (11,680) did not.
// mbedtls cannot decrypt a partial record: it needs the whole thing before it
// yields a single application byte. lwIP credits the receive window in two
// parts -- the application's share when we call altcp_recved(), and the record
// overhead in altcp_mbedtls_lower_recv, but ONLY once a record completes
// (`mbedtls_ssl_get_bytes_avail(...) == 0`). So an advertised window smaller
// than one record is a deadlock: the peer fills the window with an incomplete
// record, mbedtls yields nothing, neither credit fires, we advertise zero, and
// both sides wait forever with the connection healthy and ESTABLISHED.
//
// MBEDTLS_SSL_IN_CONTENT_LEN defaults to 16384, so a record on the wire is up
// to ~16,406 bytes. 16*TCP_MSS = 23,360 clears that with room to spare.
//
// Measured on a rev A2 board 2026-09-10 (HANDOFF 3z): the 2,027,536-byte image
// fetch stalled at a variable 36-57 KB, always with rcv_wnd=0 / rcv_ann_wnd=0,
// pbuf pool used=0 err=0 and heap err=0 -- no memory pressure, nothing queued,
// no FIN, socket still in ESTABLISHED. Every response before this one was a
// few hundred bytes of poll JSON and fit in a single small record, which is
// why nothing had ever hit it.
// 16*TCP_MSS cleared one TLS record and fixed the 3z deadlock, but it was
// sized for CORRECTNESS, not throughput -- and it then became the throughput
// limit: 23,360 bytes at a measured ~44 ms RTT is ~530 KB/s, which is exactly
// what the first working fetch achieved. A window is a bandwidth-delay
// product, so raising it is the direct lever until something else (software
// AES-GCM on a chip with no AES accelerator, most likely) becomes the ceiling.
#define TCP_WND                     (32 * TCP_MSS)
#define TCP_MSS                     1460
#define TCP_SND_BUF                 (8 * TCP_MSS)
#define LWIP_NETIF_STATUS_CALLBACK  1
#define LWIP_NETIF_LINK_CALLBACK    1
#define LWIP_NETIF_HOSTNAME         1
#define LWIP_TIMEVAL_PRIVATE        0

// --- Stats, for the 3z fetch stall ---------------------------------------
// Enabled to tell two indistinguishable failures apart: a receive window that
// closes and never reopens, versus lwIP running out of pbufs and dropping
// silently. Both present at the console as "data stopped arriving". The `err`
// counters are the discriminator -- an allocation that failed is recorded
// there and nowhere else. Costs a few hundred bytes of counters; remove once
// 3z is closed if that ever matters.
#define LWIP_STATS                  1
#define MEM_STATS                   1
#define MEMP_STATS                  1
#define TCP_STATS                   1
#define LINK_STATS                  1
#define LWIP_STATS_DISPLAY          0   // we log our own line, see tls_read()
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

// lwIP's default pool size, MEMP_NUM_SYS_TIMEOUT, is
// LWIP_NUM_SYS_TIMEOUT_INTERNAL, and that formula (opt.h) counts ONLY lwIP's
// own core modules: LWIP_TCP + IP_REASSEMBLY + LWIP_ARP + 2*LWIP_DHCP +
// LWIP_ACD + LWIP_IGMP + LWIP_DNS + PPP. It has no term for anything under
// lwip/apps/ -- so enabling SNTP below adds a sys_timeout() user that the
// pool has no slot for, and lwIP does not degrade when it runs out: it
// asserts and takes the board down.
//
// Measured on a rev A2 board 2026-09-10, on the first run that ever got past
// association:
//
//   [  149.844] c1 associated, default route w00 ip=172.16.10.216
//   *** PANIC ***
//   sys_timeout: timeout != NULL, pool MEMP_SYS_TIMEOUT is empty
//
// sntp_init() is the next statement after that log line. The board died
// there every time, which means NOTHING downstream -- SNTP, TLS,
// registration, the poll loop, the whole floppy side -- could ever have run
// on hardware, on any board, provisioned or not. It is not specific to the
// AP->STA transition; a board booting with a stored config takes the same
// path to the same panic.
//
// Sized explicitly rather than by formula, because LWIP_NUM_SYS_TIMEOUT_
// INTERNAL is defined in opt.h AFTER this header is included and cannot be
// referenced here. The budget: TCP 1, IP reassembly 1, ARP 1, DHCP 2, DNS 1,
// SNTP 1 = 7 concurrent, plus headroom. Each slot is a few tens of bytes.
#define MEMP_NUM_SYS_TIMEOUT        12

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
