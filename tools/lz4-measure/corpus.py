#!/usr/bin/env python3
"""
corpus.py: the Ethernet-frame corpus for tools/lz4-measure (PaulaNET RLE vs LZ4).

No packet capture: tcpdump needs root on this Mac. Instead, the application bytes are REAL where
they can be produced locally from our own traffic, and the Ethernet/IPv4/TCP/UDP headers around
them are built the way a stack builds them (sequence and ack numbers that advance, an IP ID that
counts, real checksums, TCP timestamps that tick):

  dl-ftp-random  to Amiga   ftp data channel, os.urandom bytes (stands for .lha/.zip/.gif files)
  dl-ftp-text    to Amiga   ftp data channel, this repo's HANDOFF.md (English prose, markdown)
  dl-ftp-source  to Amiga   ftp data channel, wifi-floppy/firmware/src/*.c (C source)
  dl-ftp-adf     to Amiga   ftp data channel, an .adf disk image (--adf; skipped without one)
  dl-http        to Amiga   REAL responses of a local python http.server (headers + body): its
                            directory listing of this repo and three design/*.html pages
  dl-dns         to Amiga   REAL DNS responses from the system resolver for 12 names
  dl-ping        to Amiga   ICMP echo replies, BSD ping layout (8-byte time + 0x08.. pattern)
  dl-arp-dhcp    to Amiga   ARP requests (60 B, zero pad) and DHCP OFFER/ACK (BOOTP, 342 B)
  dl-acks        to Amiga   the server's pure ACKs during an upload, 1 per batch
  ul-acks        to board   the Amiga's pure ACKs during a download, 5 per batch
  ul-http-req    to board   HTTP GET requests (an IBrowse-like header set), 1 per batch
  ul-dns         to board   the REAL DNS queries behind dl-dns, 1 per batch
  ul-ftp-text    to board   ftp upload of HANDOFF.md (full batches)
  ul-ftp-random  to board   ftp upload of random bytes (full batches)

Bulk flows are emitted with flush=0: the measuring tool packs them into batches as full as the
driver's and the board's rules allow. Sparse flows set flush=1 every frame (or every 5th, for
ul-acks), one batch each: the batch holds what was queued, which for them is little.

Output (big-endian): "LZ4C", u8 ntypes, ntypes x (u8 len, name); then per frame: u8 type,
u8 dir (0 = to Amiga, 1 = to board), u8 flush, u16 len, bytes. A manifest (sources, their
sha256, the DNS names and whether the live parts worked) goes to stderr and <out>.txt.
"""
import argparse, hashlib, http.server, os, random, socket, struct, sys, threading, glob, time

AMIGA_MAC = bytes.fromhex("02a5000000e1")      # locally administered placeholders
ROUTER_MAC = bytes.fromhex("02a500000001")
AMIGA_IP = bytes([172, 16, 10, 231])
SERVER_IP = bytes([172, 16, 10, 20])
ROUTER_IP = bytes([172, 16, 10, 1])
MSS = 1448                                      # 1500 - 20 - 20 - 12 (timestamps)


def csum(b):
    if len(b) & 1:
        b += b"\0"
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return (~s) & 0xFFFF


class Stack:
    """One endpoint's IPv4 ID counter; frames built with real checksums."""
    def __init__(self, mac, ip, ip_id):
        self.mac, self.ip, self.ip_id = mac, ip, ip_id

    def ipv4(self, dst_mac, dst_ip, proto, payload, ttl=64):
        self.ip_id = (self.ip_id + 1) & 0xFFFF
        h = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(payload), self.ip_id, 0x4000, ttl, proto,
                        0, self.ip, dst_ip)
        h = h[:10] + struct.pack("!H", csum(h)) + h[12:]
        return dst_mac + self.mac + b"\x08\x00" + h + payload

    def tcp(self, dst_mac, dst_ip, sport, dport, seq, ack, flags, win, ts, tsecr, data=b""):
        opt = b"\x01\x01\x08\x0a" + struct.pack("!II", ts, tsecr)
        t = struct.pack("!HHIIBBHHH", sport, dport, seq, ack, (8 << 4), flags, win, 0, 0) + opt + data
        pseudo = self.ip + dst_ip + struct.pack("!BBH", 0, 6, len(t))
        t = t[:16] + struct.pack("!H", csum(pseudo + t)) + t[18:]
        return self.ipv4(dst_mac, dst_ip, 6, t)

    def udp(self, dst_mac, dst_ip, sport, dport, data):
        u = struct.pack("!HHHH", sport, dport, 8 + len(data), 0) + data
        pseudo = self.ip + dst_ip + struct.pack("!BBH", 0, 17, len(u))
        c = csum(pseudo + u) or 0xFFFF
        u = u[:6] + struct.pack("!H", c) + u[8:]
        return self.ipv4(dst_mac, dst_ip, 17, u)


def tcp_stream(data, sender, receiver, s_mac, r_mac, sport, dport, rng, ack_every=2):
    """A bulk TCP transfer: (data segments from sender, pure ACKs from receiver), interleaved
    as [(who, frame)] with who 's' or 'r'."""
    seq, rseq = rng.getrandbits(32), rng.getrandbits(32)
    ts, rts = rng.getrandbits(31), rng.getrandbits(31)
    out, n = [], 0
    for off in range(0, len(data), MSS):
        chunk = data[off:off + MSS]
        ts += 1
        flags = 0x18 if off + MSS >= len(data) else 0x10
        out.append(("s", sender.tcp(r_mac, receiver.ip, sport, dport, seq, rseq, flags, 65535 >> 2,
                                    ts, rts, chunk)))
        seq = (seq + len(chunk)) & 0xFFFFFFFF
        n += 1
        if n % ack_every == 0 or off + MSS >= len(data):
            rts += 1
            out.append(("r", receiver.tcp(s_mac, sender.ip, dport, sport, rseq, seq, 0x10, 16384,
                                          rts, ts)))
    return out


def local_http(root, paths):
    """Real HTTP/1.0 exchanges with python's http.server on 127.0.0.1: [(request, response)]."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=root, **k)

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
    port = srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    res = []
    try:
        for p in paths:
            req = ("GET %s HTTP/1.0\r\nHost: 172.16.10.20\r\nUser-Agent: IBrowse/2.5.9 (Amiga; "
                   "AmigaOS 3.1; 68000)\r\nAccept: text/html, image/gif, image/jpeg, */*\r\n"
                   "Accept-Language: en\r\nConnection: close\r\n\r\n" % p).encode()
            s = socket.create_connection(("127.0.0.1", port), timeout=5)
            s.sendall(req)
            buf = b""
            while True:
                d = s.recv(65536)
                if not d:
                    break
                buf += d
            s.close()
            res.append((req, buf))
    finally:
        srv.shutdown()
    return res


def dns_query(name, qid):
    q = struct.pack("!HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    for part in name.split("."):
        q += bytes([len(part)]) + part.encode()
    return q + b"\0" + struct.pack("!HH", 1, 1)


def live_dns(names, server, rng):
    out = []
    for name in names:
        q = dns_query(name, rng.getrandbits(16))
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(2)
            s.sendto(q, (server, 53))
            r, _ = s.recvfrom(4096)
            s.close()
            out.append((q, r))
        except OSError:
            out.append((q, None))
    return out


def dhcp(kind, xid, rng):
    b = struct.pack("!BBBBIHH4s4s4s4s", 2, 1, 6, 0, xid, 0, 0, b"\0" * 4, AMIGA_IP, ROUTER_IP,
                    b"\0" * 4) + AMIGA_MAC + b"\0" * 10 + b"\0" * 64 + b"\0" * 128
    opts = (b"\x63\x82\x53\x63" + bytes([53, 1, kind]) + bytes([54, 4]) + ROUTER_IP +
            bytes([51, 4]) + struct.pack("!I", 86400) + bytes([1, 4, 255, 255, 255, 0]) +
            bytes([3, 4]) + ROUTER_IP + bytes([6, 4]) + ROUTER_IP + bytes([15, 3]) + b"lan" + b"\xff")
    payload = b + opts
    payload += b"\0" * max(0, 300 - len(payload))
    router = Stack(ROUTER_MAC, ROUTER_IP, rng.getrandbits(16))
    return router.udp(b"\xff" * 6, b"\xff" * 4, 67, 68, payload)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--root", required=True, help="the repo root (text, source, http)")
    ap.add_argument("--adf", help="an .adf image for dl-ftp-adf (first 256 KB used)")
    ap.add_argument("--no-live", action="store_true", help="no local http server, no DNS")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    man = []

    def src(path, limit):
        with open(path, "rb") as f:
            d = f.read(limit)
        man.append("  %-45s %8d B  sha256 %s" % (os.path.relpath(path, a.root) if path.startswith(a.root)
                                                  else os.path.basename(path), len(d),
                                                  hashlib.sha256(d).hexdigest()[:16]))
        return d

    text = src(os.path.join(a.root, "HANDOFF.md"), 256 * 1024)
    csrc = b""
    for p in sorted(glob.glob(os.path.join(a.root, "wifi-floppy/firmware/src/*.c"))):
        csrc += open(p, "rb").read()
        if len(csrc) >= 256 * 1024:
            break
    csrc = csrc[:256 * 1024]
    man.append("  %-45s %8d B  sha256 %s" % ("wifi-floppy/firmware/src/*.c (sorted, concatenated)",
                                              len(csrc), hashlib.sha256(csrc).hexdigest()[:16]))
    rnd = bytes(rng.getrandbits(8) for _ in range(256 * 1024))
    man.append("  %-45s %8d B  (random.Random(%d))" % ("random", len(rnd), a.seed))

    types = []
    frames = []

    def tid(name):
        if name not in types:
            types.append(name)
        return types.index(name)

    def emit(name, d, flush, fr):
        frames.append((tid(name), d, flush, fr))

    amiga = Stack(AMIGA_MAC, AMIGA_IP, rng.getrandbits(16))
    server = Stack(ROUTER_MAC, SERVER_IP, rng.getrandbits(16))   # off-subnet: via the router's MAC

    def download(name, data, acks_too):
        st = tcp_stream(data, server, amiga, ROUTER_MAC, AMIGA_MAC, 20, 1025 + len(types), rng)
        k = 0
        for who, f in st:
            if who == "s":
                emit(name, 0, 0, f)
            elif acks_too:
                k += 1
                emit("ul-acks", 1, 1 if k % 5 == 0 else 0, f)

    def upload(name, data):
        st = tcp_stream(data, amiga, server, AMIGA_MAC, ROUTER_MAC, 1030 + len(types), 20, rng)
        for who, f in st:
            if who == "s":
                emit(name, 1, 0, f)
            else:
                emit("dl-acks", 0, 1, f)

    download("dl-ftp-random", rnd, True)
    download("dl-ftp-text", text, True)
    download("dl-ftp-source", csrc, True)
    if a.adf:
        download("dl-ftp-adf", src(a.adf, 256 * 1024), True)
    upload("ul-ftp-text", text)
    upload("ul-ftp-random", rnd)

    live = "off (--no-live)"
    if not a.no_live:
        pages = ["/"] + ["/" + os.path.relpath(p, a.root) for p in
                         sorted(glob.glob(os.path.join(a.root, "design/*.html")))[:3]]
        try:
            ex = local_http(a.root, pages)
            for (req, resp), p in zip(ex, pages):
                man.append("  http GET %-36s %8d B response" % (p, len(resp)))
                emit("ul-http-req", 1, 1,
                     amiga.tcp(ROUTER_MAC, SERVER_IP, 1100, 80, 1, 1, 0x18, 16384, 5, 6, req))
                for off in range(0, len(resp), MSS):
                    emit("dl-http", 0, 0,
                         server.tcp(AMIGA_MAC, AMIGA_IP, 80, 1100, 1 + off, 1 + len(req), 0x10, 16383,
                                    7 + off // MSS, 5, resp[off:off + MSS]))
            names = ["amiga.org", "aminet.net", "www.google.com", "github.com", "example.com",
                     "eab.abime.net", "www.amigaportal.cz", "wikipedia.org", "pool.ntp.org",
                     "www.bbc.co.uk", "news.ycombinator.com", "www.apple.com"]
            dns = live_dns(names, "172.16.10.1", rng)
            ok = sum(1 for _, r in dns if r)
            live = "on: %d http exchanges, DNS %d/%d answered by 172.16.10.1" % (len(ex), ok, len(dns))
            man.append("  DNS names: " + " ".join(names))
            for q, r in dns:
                emit("ul-dns", 1, 1, amiga.udp(ROUTER_MAC, ROUTER_IP, 1024 + rng.getrandbits(10), 53, q))
                if r:
                    emit("dl-dns", 0, 1, server.udp(AMIGA_MAC, AMIGA_IP, 53, 1024, r))
        except OSError as e:
            live = "FAILED (%s): no dl-http, dl-dns, ul-http-req, ul-dns" % e

    for i in range(50):                               # ping replies
        t = struct.pack("!II", 1760000000 + i, rng.getrandbits(20))
        pay = t + bytes(range(8, 56))
        icmp = struct.pack("!BBHHH", 0, 0, 0, 0x1234, i) + pay
        icmp = icmp[:2] + struct.pack("!H", csum(icmp)) + icmp[4:]
        emit("dl-ping", 0, 1, server.ipv4(AMIGA_MAC, AMIGA_IP, 1, icmp, ttl=117))
    for i in range(40):                               # ARP who-has, DHCP offer/ack
        arp = (b"\xff" * 6 + ROUTER_MAC + b"\x08\x06" + struct.pack("!HHBBH", 1, 0x0800, 6, 4, 1) +
               ROUTER_MAC + ROUTER_IP + b"\0" * 6 + bytes([172, 16, 10, rng.randrange(2, 254)]))
        emit("dl-arp-dhcp", 0, 1, arp + b"\0" * (60 - len(arp)))
        if i % 4 == 0:
            emit("dl-arp-dhcp", 0, 1, dhcp(2 if i % 8 == 0 else 5, rng.getrandbits(32), rng))

    with open(a.out, "wb") as f:
        f.write(b"LZ4C" + bytes([len(types)]))
        for t in types:
            f.write(bytes([len(t)]) + t.encode())
        for t, d, fl, fr in frames:
            f.write(struct.pack("!BBBH", t, d, fl, len(fr)) + fr)
    txt = ["corpus %s: %d frames, %d types, seed %d, live parts %s" %
           (os.path.basename(a.out), len(frames), len(types), a.seed, live), "sources:"] + man
    with open(a.out + ".txt", "w") as f:
        f.write("\n".join(txt) + "\n")
    print("\n".join(txt), file=sys.stderr)


if __name__ == "__main__":
    main()
