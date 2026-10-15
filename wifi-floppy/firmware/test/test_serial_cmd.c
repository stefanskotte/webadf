#include "harness.h"
#include "../src/serial_cmd.h"
#include "../src/override_store.h"
#include <string.h>

static sc_cmd_t line(sc_state_t *s, const char *l) { sc_cmd_t c; sc_feed_line(s, l, &c); return c; }

static void show_set_clear_reboot(void) {
    sc_state_t s; sc_init(&s);
    CHECK_EQ_INT(line(&s, "wf server show").kind, SC_SHOW);
    sc_cmd_t c = line(&s, "wf server set https://my.host.example:8443/");
    CHECK_EQ_INT(c.kind, SC_SET);
    CHECK(strcmp(c.host, "my.host.example") == 0, "host");
    CHECK_EQ_INT(c.port, 8443);
    c = line(&s, "  wf server set https://10.0.0.5  ");
    CHECK_EQ_INT(c.kind, SC_SET); CHECK_EQ_INT(c.port, 443);
    CHECK_EQ_INT(line(&s, "wf server clear").kind, SC_CLEAR);
    CHECK_EQ_INT(line(&s, "wf reboot").kind, SC_REBOOT);
    CHECK_EQ_INT(line(&s, "hello").kind, SC_NONE);
    CHECK_EQ_INT(line(&s, "fwdbg x").kind, SC_NONE);
}

static void bad_urls_are_refused(void) {
    sc_state_t s; sc_init(&s);
    sc_cmd_t c = line(&s, "wf server set http://my.host");
    CHECK_EQ_INT(c.kind, SC_ERROR);
    CHECK(strcmp(c.text, "plain http is not supported -- use https://") == 0, "http refused in words");
    const char *bad[] = { "wf server set my.host", "wf server set https://", "wf server set https://a b",
                          "wf server set https://h:0", "wf server set https://h:65536", "wf server set https://h/x",
                          "wf server set ftp://h", "wf server set https://h:12ab" };
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        c = line(&s, bad[i]);
        CHECK(c.kind == SC_ERROR && strcmp(c.text, "usage: wf server set https://host[:port]") == 0, bad[i]);
    }
    char longhost[100] = "wf server set https://";
    memset(longhost + strlen(longhost), 'a', 64); longhost[22 + 64] = '\0';
    CHECK_EQ_INT(line(&s, longhost).kind, SC_ERROR);
    CHECK(strcmp(line(&s, "wf server bogus").text, "unknown command -- wf server show|set|tls|clear, wf reboot") == 0, "unknown");
}

static void noverify_needs_yes(void) {
    sc_state_t s; sc_init(&s);
    sc_cmd_t c = line(&s, "wf server tls noverify");
    CHECK_EQ_INT(c.kind, SC_ASK);
    c = line(&s, "yes");
    CHECK(c.kind == SC_ERROR && strcmp(c.text, "not confirmed -- nothing changed") == 0, "lowercase is not YES");
    CHECK_EQ_INT(line(&s, "YES").kind, SC_NONE);                 // nothing pending any more: ignored
    CHECK_EQ_INT(line(&s, "wf server tls noverify").kind, SC_ASK);
    c = line(&s, "YES");
    CHECK(c.kind == SC_TLS && c.tls == OVR_TLS_NOVERIFY, "confirmed");
    c = line(&s, "wf server tls verify");
    CHECK(c.kind == SC_TLS && c.tls == OVR_TLS_VERIFY, "verify needs no confirmation");
}

static void line_assembly(void) {
    sc_state_t s; sc_init(&s);
    sc_cmd_t c; const char *in = "wf rebooX\x08t\r\n";
    int got = 0;
    for (const char *p = in; *p; p++) if (sc_feed_char(&s, (unsigned char)*p, &c)) { got++; CHECK_EQ_INT(c.kind, SC_REBOOT); }
    CHECK_EQ_INT(got, 1);                                         // CRLF is one line, backspace edits
    for (int i = 0; i < SC_LINE_MAX + 10; i++) CHECK(!sc_feed_char(&s, 'x', &c), "no line yet");
    CHECK(sc_feed_char(&s, '\n', &c), "the long line ends");
    CHECK(c.kind == SC_ERROR && strcmp(c.text, "line too long -- ignored") == 0, "discarded whole");
    const char *ok = "wf server show\n";
    got = 0;
    for (const char *p = ok; *p; p++) if (sc_feed_char(&s, (unsigned char)*p, &c)) { got++; CHECK_EQ_INT(c.kind, SC_SHOW); }
    CHECK_EQ_INT(got, 1);                                         // the next line is clean
}

int main(void) {
    RUN(show_set_clear_reboot);
    RUN(bad_urls_are_refused);
    RUN(noverify_needs_yes);
    RUN(line_assembly);
    return REPORT();
}
