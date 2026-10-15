#ifndef SERIAL_CMD_H
#define SERIAL_CMD_H
// The USB-serial console grammar for the server override ("wf server ...",
// "wf reboot"). Pure: no SDK, no flash, no I/O. The caller (core0's loop)
// feeds it characters and acts on what comes back.
#include <stdbool.h>
#include <stdint.h>
#include "override_store.h"

#define SC_LINE_MAX 128

typedef enum { SC_NONE = 0, SC_SHOW, SC_SET, SC_TLS, SC_CLEAR, SC_REBOOT, SC_ASK, SC_ERROR } sc_kind_t;

typedef struct {
    sc_kind_t kind;
    char host[OVERRIDE_HOST_MAX + 1];   // SC_SET
    uint16_t port;                      // SC_SET
    uint8_t tls;                        // SC_TLS (ovr_tls_t)
    const char *text;                   // SC_ASK: the question; SC_ERROR: why (static strings)
} sc_cmd_t;

typedef struct {
    char line[SC_LINE_MAX + 1]; uint16_t len; bool overflow;
    bool pending;                       // a noverify waiting for YES
} sc_state_t;

void sc_init(sc_state_t *s);
// One character from the console. True when a whole line is ready in *out (the action to take).
bool sc_feed_char(sc_state_t *s, int ch, sc_cmd_t *out);
// One whole line (the same rules; sc_feed_char calls it). Lines not starting "wf " are SC_NONE (ignored).
void sc_feed_line(sc_state_t *s, const char *line, sc_cmd_t *out);

#endif
