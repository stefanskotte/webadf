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

// Same as fake_push_response, but for a response containing bytes that
// don't survive a C string (a real WFMF image body embeds NUL bytes in its
// header alone) -- `len` is exact, not strlen()'d.
void fake_push_response_bytes(const uint8_t *raw, int len);

// Deliver only the first `n` bytes of `raw` for the next request, then
// report a dropped connection: read() returns 0 (clean close) from then on,
// exactly as a connection dying mid-body looks to the layer above. `n` must
// be <= strlen(raw).
void fake_push_truncated(const char *raw, int n);

// The next connect() call fails (returns < 0) instead of succeeding. A
// connect that failed reached nothing and changes nothing: in particular a
// connection being held open stays held, exactly as a real transport whose
// held socket was not reusable (idle cap expired) and whose fresh attempt
// then failed would leave it. Releasing it is the caller's abandon().
void fake_push_connect_failure(void);

// The server HOLDS the next request: deliver `prefix` (may be "", which is
// the long poll's normal shape -- nothing at all until the server has news),
// then, instead of a clean close, every read() WAITS. A waiting read() does
// what transport_tls.c's does: it asks the transport's `interrupted`
// predicate, and returns TRANSPORT_INTERRUPTED if one is installed and says
// true -- otherwise it waits out its timeout and returns -1. So a test sees
// an interrupt only when the client under test actually installed the
// predicate for this request, which is the property being tested.
void fake_push_held(const char *prefix);

// How many times abandon() has been called since fake_reset(). Idempotent
// abandons (dc_exchange repeats one dc_attempt already made) count each time.
int fake_abandon_count(void);

// The fake transport_t. Always returns the same instance.
transport_t *fake_transport(void);

// The bytes written via write() since the most recent connect(), NUL
// terminated. Valid until the next fake_reset() or connect().
const char *fake_last_request(void);

// Exact length of the bytes written since the most recent connect(). Use it
// for a binary body: fake_last_request()'s C string stops at the first NUL.
int fake_last_request_len(void);

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

// --- keep-alive ---------------------------------------------------------
// The fake models the real transport's keep-alive, because the retry rule
// above it cannot be tested honestly otherwise:
//   * close() KEEPS the connection (the caller is saying the response
//     finished); abandon() really ends it.
//   * the next connect() hands a kept connection back and reports
//     reused == true for THAT connect only -- `reused` is per-connect, not
//     a mode the test switches on.
//   * a kept connection consumes no scripted response until it is used.
//
// Pretend a previous exchange left a connection open (true), or that none is
// held (false). Equivalent to running a clean exchange first, for tests that
// care only about what happens to the NEXT one. Cleared by fake_reset().
void fake_set_reused(bool reused);

// The connection currently being held open is dead at the far end: the next
// connect() still hands it back (reused == true -- nothing announces a
// socket that expired), and then read() fails. write() fails too, except
// with fake_set_max_write() in force, where the first write is swallowed (a
// dying socket's local buffer takes one segment) and the next one fails --
// a half-sent request, which is the shape that must never be left on a
// socket for the next request to append to. A close() on such a connection
// holds it AND keeps it dead: nothing announced its death, so close() has no
// way to know. This is the one failure keep-alive introduces and the only
// one the retry rule is allowed to act on.
void fake_kill_kept_connection(void);

// Did the most recent connect() hand back a kept connection? The same value
// the client under test saw through transport.h's `reused`, recorded per
// connect, so a test can assert that a RETRY landed on a fresh connection.
bool fake_last_reused(void);

// Is a connection being held open right now (close()d, not abandon()ed)?
bool fake_connection_is_kept(void);

// Drive the injected clock (see transport.h's clock_ms_fn).
void fake_set_clock(uint32_t ms);
uint32_t fake_clock_ms(void);

#endif
