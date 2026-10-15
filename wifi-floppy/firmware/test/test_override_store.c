#include "harness.h"
#include "../src/override_store.h"
#include <stdio.h>
#include <string.h>

static server_override_t mk(const char *host, uint16_t port, uint8_t tls) {
    server_override_t o; memset(&o, 0, sizeof o);
    snprintf(o.host, sizeof o.host, "%s", host); o.port = port; o.tls = tls; return o;
}

static void round_trip_and_erase(void) {
    override_store_erase();
    server_override_t got;
    CHECK(!override_store_load(&got), "erased: nothing");
    server_override_t o = mk("my.host.example", 8443, OVR_TLS_NOVERIFY);
    CHECK(override_store_save(&o), "saved");
    CHECK(override_store_load(&got), "loaded");
    CHECK(strcmp(got.host, "my.host.example") == 0, "host");
    CHECK_EQ_INT(got.port, 8443);
    CHECK_EQ_INT(got.tls, OVR_TLS_NOVERIFY);
    override_store_erase();
    CHECK(!override_store_load(&got), "erased again");
}

static void invalid_fields_are_refused(void) {
    char longhost[80]; memset(longhost, 'a', 64); longhost[64] = '\0';
    server_override_t o; memset(&o, 0, sizeof o);
    memcpy(o.host, longhost, sizeof o.host);          // no NUL inside the array
    CHECK(!override_store_save(&o), "no terminator: refused");
    o = mk("", 443, OVR_TLS_VERIFY);
    CHECK(!override_store_save(&o), "empty host: refused");
    o = mk("h", 0, OVR_TLS_VERIFY);
    CHECK(!override_store_save(&o), "port 0: refused");
    o = mk("h", 443, 2);
    CHECK(!override_store_save(&o), "unknown tls mode: refused");
    o = mk("bad host", 443, OVR_TLS_VERIFY);
    CHECK(!override_store_save(&o), "a space in the host: refused");
}

static void a_corrupt_record_reads_as_nothing(void) {
    server_override_t o = mk("my.host", 443, OVR_TLS_VERIFY), got;
    CHECK(override_store_save(&o), "saved");
    override_store_test_corrupt_payload_byte();
    CHECK(!override_store_load(&got), "CRC catches a damaged payload");
    CHECK(override_store_save(&o), "saved");
    override_store_test_corrupt_magic();
    CHECK(!override_store_load(&got), "magic");
    override_store_erase();
}

static void the_effective_server(void) {
    server_override_t eff, o = mk("my.host", 8443, OVR_TLS_NOVERIFY);
    server_effective(false, NULL, "webadf.vercel.app", &eff);
    CHECK(strcmp(eff.host, "webadf.vercel.app") == 0 && eff.port == 443 && eff.tls == OVR_TLS_VERIFY, "default");
    CHECK(!server_is_custom(&eff, "webadf.vercel.app"), "default is not custom");
    server_effective(true, &o, "webadf.vercel.app", &eff);
    CHECK(strcmp(eff.host, "my.host") == 0 && eff.port == 8443 && eff.tls == OVR_TLS_NOVERIFY, "override");
    CHECK(server_is_custom(&eff, "webadf.vercel.app"), "custom");
    char hdr[OVERRIDE_HOST_MAX + 7];
    server_host_header(&eff, hdr, sizeof hdr);
    CHECK(strcmp(hdr, "my.host:8443") == 0, "Host header carries a non-default port");
    eff.port = 443;
    server_host_header(&eff, hdr, sizeof hdr);
    CHECK(strcmp(hdr, "my.host") == 0, "...and not 443");
}

int main(void) {
    RUN(round_trip_and_erase);
    RUN(invalid_fields_are_refused);
    RUN(a_corrupt_record_reads_as_nothing);
    RUN(the_effective_server);
    return REPORT();
}
