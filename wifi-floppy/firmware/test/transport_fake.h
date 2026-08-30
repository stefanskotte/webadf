#ifndef TRANSPORT_FAKE_H
#define TRANSPORT_FAKE_H
// A scriptable, fault-injecting transport_t for the host test build. Every
// test in tasks 6+ that exercises the device protocol state machine talks
// to the network only through this fake, so it must never lie: a truncated
// response must report exactly the bytes it was told to, then a clean
// close -- not more, not less, not a different kind of failure.
#include "../src/transport.h"

// Clear all queued responses/failures, the recorded request, the request
// count, and the injected clock. Call at the start of every test.
void fake_reset(void);

// Queue a whole response to be delivered for the next connect()+read()
// cycle. `raw` must fit within the fake's static response buffer (see
// transport_fake.c); pushing something too large aborts the test binary
// loudly rather than truncating silently.
void fake_push_response(const char *raw);

// Deliver only the first `n` bytes of `raw` for the next request, then
// report a dropped connection: read() returns 0 (clean close) from then on,
// exactly as a connection dying mid-body looks to the layer above. `n` must
// be <= strlen(raw).
void fake_push_truncated(const char *raw, int n);

// The next connect() call fails (returns < 0) instead of succeeding.
void fake_push_connect_failure(void);

// The fake transport_t. Always returns the same instance.
transport_t *fake_transport(void);

// The bytes written via write() since the most recent connect(), NUL
// terminated. Valid until the next fake_reset() or connect().
const char *fake_last_request(void);

// Number of connect() calls made since fake_reset() -- i.e. how many
// request/response cycles the client under test has run (the fake's model
// is one queued event consumed per connect(), regardless of how many
// write() calls the client used to send the request; a client that splits
// a request across multiple writes must not inflate this count).
int fake_request_count(void);

// Cap how many bytes a single write() call accepts, simulating a real
// socket's short writes under backpressure. 0 or negative (the default,
// set by fake_reset()) means unlimited: a write() accepts everything
// offered, as before. A positive `n` makes the next write() (and every one
// after, until changed) accept at most `n` bytes and return that count --
// callers that don't loop on a short write will visibly fail to send the
// rest of their request.
void fake_set_max_write(int n);

// Drive the injected clock (see transport.h's clock_ms_fn).
void fake_set_clock(uint32_t ms);
uint32_t fake_clock_ms(void);

#endif
