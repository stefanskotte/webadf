// Pure DNS responder for the captive portal (see dns_server.h). Answers
// every A query with the portal's own address so a client on the AP always
// resolves somewhere -- that is what makes a phone show "Sign in to
// network" instead of reporting a network with no internet. Any other
// qtype (a phone's AAAA probe, notably) gets an empty NOERROR reply, not
// an A record with the wrong type on it -- see the qtype check below.
//
// No pico-sdk/lwIP includes here -- only C standard headers -- so this
// links into the host test build unmodified (test/run.sh compiles every
// src/*.c, minus a small device-only exclusion list, into every test
// binary). Task 6 binds a UDP socket to it.
#include "dns_server.h"
#include <stdbool.h>

#define DNS_HDR_LEN 12

// Fixed-size answer record emitted for an A query (and only for an A
// query -- see the qtype check below): a compressed name
// pointer back to the question (2), TYPE (2), CLASS (2), TTL (4),
// RDLENGTH (2), RDATA (4) = 16 bytes.
#define DNS_ANSWER_LEN 16

int dns_handle(const uint8_t *req, int len, uint8_t *out, int cap) {
    if (len < DNS_HDR_LEN) return 0;              // header cut short

    // QR bit (top bit of byte 2, the flags high byte): never answer
    // something that is itself a response -- two responders on one segment
    // would otherwise answer each other forever.
    if (req[2] & 0x80) return 0;

    int qdcount = (req[4] << 8) | req[5];
    if (qdcount < 1) return 0;                    // no question section

    // Walk the question's labels to find where it ends. Every step is
    // bounded against `len` *before* the byte it reads is used for
    // anything -- a label length that runs past the remaining input is
    // malformed, not something to trust arithmetic on.
    int pos = DNS_HDR_LEN;
    for (;;) {
        if (pos >= len) return 0;                 // question cut short
        int lab = req[pos];
        if (lab == 0) { pos += 1; break; }         // root label: name ends
        // Compression pointers (top two bits set) are not a plain label
        // length and are not supported in an incoming question -- refuse
        // rather than mis-walk the name.
        if (lab & 0xC0) return 0;
        // 1 (length byte) + lab (label bytes) must fit before `len`.
        if (pos + 1 + lab > len) return 0;         // label runs past input
        pos += 1 + lab;
    }
    // QTYPE (2) + QCLASS (2) must follow the terminating root label.
    if (pos + 4 > len) return 0;                   // question cut short
    int qend = pos + 4;
    int qtype = (req[pos] << 8) | req[pos + 1];

    // Final-review Minor 5: this used to answer EVERY qtype with a TYPE A
    // record, which spec S6 never claimed and which is a type mismatch --
    // a phone's AAAA probe (qtype 28, which iOS and Android both send
    // alongside the A query for their captive-portal check hostnames) got
    // back an answer section whose RR type does not match the question.
    // A resolver is entitled to treat that as a broken server rather than
    // as "no AAAA record".
    //
    // The answer for anything that is not A is an empty NOERROR reply --
    // header + question echoed, ANCOUNT 0 -- rather than silence. Silence
    // makes the client wait out its own retry timer before falling back to
    // the A query, which is exactly the delay-then-give-up that stops the
    // sign-in sheet appearing; an immediate "that name exists, no record
    // of that type" gets it to the A query at once.
    bool is_a = (qtype == 1);

    // The reply is: the 12-byte header, verbatim question (qend - 0... we
    // copy from offset 0 through qend), then -- for an A query only -- one
    // fixed-size answer record.
    int reply_len = qend + (is_a ? DNS_ANSWER_LEN : 0);
    if (reply_len > cap) return 0;                 // would not fit -- refuse

    // Header + question copied verbatim, then patched in place.
    for (int i = 0; i < qend; i++) out[i] = req[i];

    // Flags: response, recursion available (opcode/AA/TC/RD/RCODE all 0).
    out[2] = 0x81;
    out[3] = 0x80;
    // ANCOUNT = 1 for the A record below, 0 for the empty NOERROR reply
    // every other qtype gets (NSCOUNT/ARCOUNT already 0 from the copied
    // header, since the offer this responder makes never sets them).
    out[6] = 0x00; out[7] = is_a ? 0x01 : 0x00;
    out[8] = 0x00; out[9] = 0x00;
    out[10] = 0x00; out[11] = 0x00;

    if (!is_a) return reply_len;

    uint8_t *a = out + qend;
    a[0] = 0xC0; a[1] = 0x0C;      // name: pointer to the question at offset 12
    a[2] = 0x00; a[3] = 0x01;      // TYPE A
    a[4] = 0x00; a[5] = 0x01;      // CLASS IN
    a[6] = 0x00; a[7] = 0x00; a[8] = 0x00; a[9] = 0x3C;  // TTL 60
    a[10] = 0x00; a[11] = 0x04;    // RDLENGTH 4
    a[12] = PORTAL_IP_0;
    a[13] = PORTAL_IP_1;
    a[14] = PORTAL_IP_2;
    a[15] = PORTAL_IP_3;

    return reply_len;
}
