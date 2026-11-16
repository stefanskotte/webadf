#ifndef LWIPOPTS_H
#define LWIPOPTS_H
#define NO_SYS                      1
#define LWIP_SOCKET                 0
#define LWIP_NETCONN                0
#define MEM_ALIGNMENT               4
// 24 KB since fw 1.20.0 (bench 2026-10-21): this heap holds the TLS send queue (up to TCP_SND_BUF of PBUF_RAM
// segments), every frame from the Amiga (pnet_bridge.c) and its out-of-order queue (AS_UP_OOSEQ_BYTES) at once
// during an upload from the Amiga; at 16 KB tcp_write ran out about every 30 s (tls_room.h). The 8 KB comes out of
// the C heap, whose measured low-water was 32,768 B against its 20,480 B floor.
#define MEM_SIZE                    24576
// (Not MEM_LIBC_MALLOC: pico_cyw43_arch_threadsafe_background.c #errors on
// that combination outright -- lwIP's mem_malloc can run from the
// low-priority IRQ context this arch mode uses, and newlib malloc isn't
// safe to call from there. This only governs lwIP's own small internal
// allocations (e.g. altcp's per-connection wrapper struct) -- the ~16 KB
// in/out TLS record buffers mbedtls_ssl_setup() allocates are separate
// mbedtls_calloc() calls that land on the ordinary C heap, not here.)
#define MEMP_NUM_TCP_SEG            32
// MUST EXCEED TCP_WND/TCP_MSS, WITH HEADROOM. The receive window is a promise
// that the peer may have that many bytes in flight, and every arriving segment
// needs a pool pbuf to land in -- so a pool sized at exactly the window is a
// pool with no slack for ARP, DNS, retransmits or the next segment arriving
// while one is being consumed. When it runs dry lwIP silently DROPS packets
// and the transfer stalls, which presents identically to the 3z deadlock.
//
// Caught on hardware 2026-09-11, and self-inflicted: raising TCP_WND from
// 16 to 32*TCP_MSS for throughput left this at 32, i.e. exactly 46720/1460
// segments. The board then reported `pbuf used=32 max=32 err=49` and needed
// three attempts and 94 s to mount what it had been mounting first time in
// under 5 s. It was LATENT while I measured throughput -- those runs happened
// to succeed -- which is why it reached a commit.
//
// 64 against a 32-segment window is 2x. Costs ~64 * ~1.5 KB of SRAM.
#define PBUF_POOL_SIZE              64
#define LWIP_ARP                    1
#define LWIP_ICMP                   1
#define LWIP_DHCP                   1
#define LWIP_DNS                    1
#define LWIP_TCP                    1
// Address reuse for the setup portal's listeners (portal_net.c sets
// SOF_REUSEADDR on them; nothing else does, so every other pcb behaves
// exactly as before). lwIP's name for this is SO_REUSE, not LWIP_SO_REUSE.
//
// Without it the portal could never come back up within two minutes of a
// submit: every HTTP connection the portal closes first sits in TIME_WAIT
// for 2*TCP_MSL = 120 s with local port 80, and tcp_bind(ANY, 80) scans
// tcp_tw_pcbs and returns ERR_USE. On the bench (2026-10-09, fw 1.9.3) a
// rejected pairing code re-raised the portal 1.3 s after the submit and the
// board hung in setup_http(). Reproduced on the host against these exact
// lwIP sources; portal_net.c's "Re-raising the portal" comment has the trace.
#define SO_REUSE                    1
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
// (The setup portal adds no sys_timeout user: its DHCP and DNS servers are raw udp_recv callbacks and its HTTP
// connections use tcp_poll, which runs on the TCP timer already counted. So the AP beside the station needs none.)

// --- PCB pools for the setup page opened beside the station (bench 2026-11-15, fw 1.25.0 TEST) --------------------
// lwIP's defaults are MEMP_NUM_UDP_PCB 4 and MEMP_NUM_TCP_PCB 5, sized for the station alone. With the Wi-Fi
// networks setup page open beside it (the AP and its servers up while the board stays online) the UDP pool ran dry:
// every DNS lookup then failed -- dns_gethostbyname() ERR_MEM, "tls: DNS call refused (code -101)" -- and the board
// was offline to the server for the whole ten minutes. LWIP_DNS_SECURE (lwIP's default) includes RAND_SRC_PORT, so
// each lookup in flight takes a pcb of its own (dns.c dns_alloc_random_port, up to DNS_MAX_SOURCE_PORTS =
// DNS_TABLE_SIZE), and lwIP gives up with ERR_MEM only when the DNS client holds none at all -- which is exactly
// what a full pool leaves it.
//
// The budget, counted from the code (test/test_lwip_budget.c checks it; portal_net.c asserts its own share):
//   UDP: the DHCP client 1 (dhcp.c, one shared pcb) + SNTP 1 (sntp.c) + DNS lookups in flight DNS_TABLE_SIZE
//        + the portal's DHCP and DNS servers 2                                              = 8
//   TCP: the HTTPS connection 2 (one being abandoned or in TIME_WAIT while the next connects) + the Amiga's Transfer
//        connection 1 (amiga_tcp.c) + the portal's HTTP connections 3 (MAX_HTTP_CONNS)       = 6, plus 2 spare
//        (an exhausted TCP pool makes lwIP kill a live connection by priority, tcp_alloc)    = 8
// Listening pcbs (MEMP_NUM_TCP_PCB_LISTEN, default 8): the portal's one, and a TEST build's a2b_discard: no change.
// Cost, measured in the map (memp_memory_*_base): UDP +128 B (4 x 32), TCP +468 B (3 x 156), and the ALTCP pool,
// which follows MEMP_NUM_TCP_PCB, +132 B: +732 B of .bss against master -- 16 B below the build before the Wi-Fi
// networks work, which freed 748 B for it (HANDOFF, ruling F2).
#define DNS_TABLE_SIZE              4
#define WF_UDP_PCB_DHCP_CLIENT      1
#define WF_UDP_PCB_SNTP             1
#define WF_UDP_PCB_PORTAL           2
#define WF_UDP_PCB_BUDGET           (WF_UDP_PCB_DHCP_CLIENT + WF_UDP_PCB_SNTP + DNS_TABLE_SIZE + WF_UDP_PCB_PORTAL)
#define WF_TCP_PCB_TLS              2
#define WF_TCP_PCB_AMIGA            1
#define WF_TCP_PCB_PORTAL_HTTP      3
#define WF_TCP_PCB_SPARE            2
#define WF_TCP_PCB_BUDGET           (WF_TCP_PCB_TLS + WF_TCP_PCB_AMIGA + WF_TCP_PCB_PORTAL_HTTP + WF_TCP_PCB_SPARE)
#define MEMP_NUM_UDP_PCB            WF_UDP_PCB_BUDGET
#define MEMP_NUM_TCP_PCB            WF_TCP_PCB_BUDGET

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
// PaulaNET (WF_PNET_L2 builds, every DF1 mode -- plan 2026-10-12 ruling 4): the
// board's own DHCP client-id. See the hook file.
#if WF_PNET_L2
#define LWIP_HOOK_FILENAME "pnet_lwip_hooks.h"
// Shared-IP mode (pnet_shared.h, ruling 2026-11-15): lwIP and the Amiga's AmiTCP_NG may use ONE address, so their
// outgoing tuples must never collide. AmiTCP_NG picks ephemeral ports in 49152-65535 (IPPORT_ANONMIN, random) --
// lwIP's own default range -- so lwIP's move to 0x8000-0xBFFF (32768-49151). These three are each #ifndef-guarded
// in pico-sdk 2.3.0's lwIP 2.2.1 (core/tcp.c, core/udp.c); ENSURE maps any 16-bit value into the range (the default
// form, `& ~START + START`, only works for a range starting on its own size). DNS picks a random source port per
// query (LWIP_DNS_SECURE_RAND_SRC_PORT, core/dns.c dns_alloc_random_port: retries until DNS_PORT_ALLOWED), so it is
// held to the same range. Every mode, not only shared: the range is a property of the build, and 32768+ is
// what Linux hands out anyway.
#define TCP_LOCAL_PORT_RANGE_START        0x8000
#define TCP_LOCAL_PORT_RANGE_END          0xBFFF
#define TCP_ENSURE_LOCAL_PORT_RANGE(port) ((u16_t)(((port) & 0x3FFFu) + TCP_LOCAL_PORT_RANGE_START))
#define UDP_LOCAL_PORT_RANGE_START        0x8000
#define UDP_LOCAL_PORT_RANGE_END          0xBFFF
#define UDP_ENSURE_LOCAL_PORT_RANGE(port) ((u16_t)(((port) & 0x3FFFu) + UDP_LOCAL_PORT_RANGE_START))
#define DNS_PORT_ALLOWED(port)            ((port) >= 0x8000u && (port) <= 0xBFFFu)
#endif
#endif
