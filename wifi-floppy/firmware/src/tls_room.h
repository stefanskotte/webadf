#ifndef TLS_ROOM_H
#define TLS_ROOM_H
// Whether lwIP's heap has room for one TLS write (fw 1.20.0, bench 2026-10-21).
//
// altcp_write() on the TLS pcb encrypts a record and hands it to tcp_write(),
// which copies it into PBUF_RAM segments from lwIP's heap (MEM_SIZE). That
// heap also holds the TLS connection's unacknowledged send queue (up to
// TCP_SND_BUF) and every frame from the Amiga (pnet_bridge.c, PBUF_RAM), with
// the Amiga connection's out-of-order queue (AS_UP_OOSEQ_BYTES). During an
// upload from the Amiga all three peak together, the segment allocation fails,
// and altcp_write returns ERR_MEM -- AFTER the record was encrypted, so the
// TLS stream is lost and the connection must go (transport_tls.c). On the
// A500 bench this happened about every 30 s and held uploads to 2-6 KB/s.
//
// So tls_write() waits until this says yes, the way it already waits for
// send-buffer space: acknowledgements free the send queue within an RTT.
// The figure is an upper bound on what the write allocates plus a reserve
// left for the Amiga's frames, so a frame that arrives meanwhile still lands.
// It counts free bytes, not the largest free block; each segment is at most
// one MSS, which keeps the difference small on a first-fit heap.
//
// Pure C: test/test_tls_room.c drives it on the host.
#include <stdbool.h>
#include <stdint.h>

#define TLS_ROOM_RECORD_OVERHEAD 29u   // per record: 5 header + 8 explicit nonce + 16 tag (AES-GCM)
#define TLS_ROOM_SEG_OVERHEAD    96u   // per segment: struct pbuf, Ethernet/IP/TCP headers, mem header, alignment
#define TLS_ROOM_RESERVE       4608u   // for the Amiga: a 2,920-byte out-of-order queue plus one 1,514-byte frame

static inline uint32_t tls_room_needed(uint32_t n, uint32_t mss) {
    const uint32_t wire = n + TLS_ROOM_RECORD_OVERHEAD;
    const uint32_t segs = (wire + mss - 1u) / mss;
    return wire + segs * TLS_ROOM_SEG_OVERHEAD + TLS_ROOM_RESERVE;
}

// avail/used: lwIP's MEM_STATS (lwip_stats.mem). used > avail never happens;
// it reads as no room rather than wrapping.
static inline bool tls_room_ok(uint32_t avail, uint32_t used, uint32_t n, uint32_t mss) {
    return used <= avail && avail - used >= tls_room_needed(n, mss);
}

#endif
