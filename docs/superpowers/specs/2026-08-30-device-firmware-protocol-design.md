# Device firmware — protocol plane (plan 4a)

**Status: delivered 2026-08-30.** Everything this spec scoped is done and evidenced by a
green host suite (`pnpm firmware:test`, 282 checks across 8 binaries) plus a green ARM
cross-build (`pnpm firmware:build` → `wifi-floppy/firmware/build/wifi_floppy.uf2`). Nothing
in this delivery has run on real hardware — boards were still in transit throughout. Plans
4b and 5 are what remain; see "What plan 4a delivered" below.

**Addendum to `2026-08-23-webadf-design.md`.** That spec remains the binding authority.
This one implements the firmware half of `2026-08-29-device-plane-disk-change-design.md`
§10 — the device contract that spec wrote *for* a firmware author without writing the
firmware. It is the first spec in this project whose subject is C on the RP2350 rather
than TypeScript on Vercel.

**Scope:** the protocol plane only. Making the firmware build at all, TLS, the §10 state
machine, two-slot PSRAM, and the two recorded defects. **Provisioning UX is plan 4b**
(AP-mode captive portal); **hardware bring-up is plan 5**, when boards arrive. Write-back
remains backlog and is not designed here.

**Realises D16** ("the firmware gains TLS and a bearer token and talks to webadf
directly"), which has been recorded as a decision since plan 2 and never implemented.

---

## What plan 4a delivered, and what it did not

Read this before the rest of the spec below, which was written as a plan and is kept as a
record of the design reasoning — it now describes what was built, not what remains to be.

**Delivered and host/cross-build evidenced:**

- The firmware **compiles** for the first time ever: `pnpm firmware:build` produces
  `wifi-floppy/firmware/build/wifi_floppy.uf2`, on pico-sdk **2.3.0** (enforced by a CMake
  version guard) with the official ARM GNU Toolchain (not homebrew's
  `arm-none-eabi-gcc`, which ships no newlib).
- A **host test suite** exists and passes: `pnpm firmware:test` — plain C under clang, 282
  checks across 8 binaries, no framework.
- Both **recorded defects are fixed**: `TRACK_SLOT_BYTES`/`TRACK_MFM_MAX` collapsed into
  one `TRACK_MAX_BYTES`, and the `(bits + 7) / 8` overflow now bounds `bits` before the
  arithmetic. `src/lib/adfmfm/firmware-parser.ts` was updated in the same change and no
  longer mirrors the second defect — the device it modelled no longer has that bug.
- The full §10 device contract: the poll loop, both `since` rules, the status-code tables,
  exponential backoff with jitter, six-field status reports, two-slot PSRAM with
  generation-tagged publish (so a reused slot index cannot serve a stale disk), and
  fetch-before-transition.
- **TLS is real and proved load-bearing**: mbedTLS over lwIP altcp, with
  `MBEDTLS_SSL_VERIFY_REQUIRED` enforced by both a CMake define and an `#error` guard, a
  five-root pinned CA bundle verified against the live `webadf.vercel.app` chain, SNTP
  before the first handshake, and `-Wl,-u,...` link options proved (by removing them) to be
  the only thing stopping `--gc-sections` from silently discarding the whole TLS chain.
- Registration (`POST /api/device/register`) and a flash-backed token store work end to
  end in `main.c`, including backoff on repeated registration failure and a torn-write
  guard on the stored token.
- `src/http_fetch.c`/`.h` — the old plaintext, path-addressed, credential-less fetcher —
  are **deleted**.

**Not delivered, and not this plan's job:**

- **Plan 4b** — the AP-mode captive portal (DHCP, DNS, an HTTP config page, flash-backed
  WiFi credentials), replacing today's compile-time `WIFI_SSID`/`WIFI_PASS`/
  `WEBADF_HOST`/`WEBADF_PAIRING_CODE`.
- **Plan 5** — hardware bring-up. Nothing built here has ever run on real hardware: no TLS
  handshake, no SNTP sync, no floppy-bus timing has been exercised outside the host suite
  and the cross-build. Boards were in transit for the whole of this plan.
- **Write-back** remains undesigned backlog. `WRITE_BACK_IMPLEMENTED` is `0` in `main.c`,
  so WPROT is asserted always.

A dozen minor findings were deliberately deferred during 4a rather than fixed inline, and
several rulings were taken on the operator's behalf during execution (a wrong pico-sdk
version pin, several wrong hand-counted `Content-Length` fixtures, two "green suite proved
nothing" incidents). All of it is recorded in
`docs/decisions/2026-08-30-device-firmware-rulings.md`; `HANDOFF.md` points to it under
"Before you touch the firmware again".

---

## 1. What is actually there today

The gap is wider than "add TLS", and the plan is unbuildable if this is misjudged, so it
is recorded first.

`wifi-floppy/firmware/` is 854 lines across seven `.c` files. **It has never been
compiled, by anyone, once.** There is no toolchain on the development machine: no `cmake`,
no `arm-none-eabi-gcc`, no `ninja`, no `picotool`, `PICO_SDK_PATH` unset, no pico-sdk
checkout. "Expect minor compile fixes" in the firmware README is optimistic framing of a
program that has never been through a compiler.

What the network layer does today:

| Today | The §10 contract |
|---|---|
| One fetch at boot, then never talks again | Long-poll loop for the life of the device |
| `GET /image/0` — an integer image id | `GET /api/device/image/<sha256>` |
| Plaintext HTTP to a hardcoded `192.168.1.10:8000` | TLS to `webadf.vercel.app` |
| No credentials of any kind | `Authorization: Bearer <device token>` |
| No status reporting | `POST /api/device/status`, ~60 s and on transition |
| No `since`, no versions, no reconciliation | `since`-based desired-state reconciliation |
| One PSRAM image, loaded once | Two slots, fetch-before-transition |

So this is not a firmware being secured. It is a LAN prototype that predates the protocol
it now has to speak, and the protocol plane is largely new code. The floppy-bus half —
`floppy.pio`, `dskchg.c`, `track_cache.c`, core0's ISRs and DMA — is a different matter:
it is desk-checked, unverifiable without hardware, and **out of scope here**. This plan
does not touch it, except for one ISR attribute in §6.

## 2. The property this plane must not break

Inherited unchanged from the disk-change spec §1: **losing the webservice degrades disk
*swapping*, not disk *serving*.** Every rule below serves it, and the firmware is where it
is actually enforced — the server can only ever *describe* a desired state, and it is the
device that decides what the Amiga sees.

Two failure modes are therefore forbidden outright, and both are easy to write by
accident:

1. **An eject nobody asked for.** Absence of signal — a timeout, a 5xx, a dropped
   connection, a deleted device row — never changes what is mounted. Only an explicit
   `desired: null` ejects.
2. **A diskless gap on every swap.** Never release the current disk before the
   replacement is fetched *and* verified. Fetch into the other slot; swap last.

## 3. Architecture: one seam, deliberately placed

Approach chosen over two alternatives (a thin `altcp_tls` shim; a full host-simulating
HAL). The decisive question was what can be *proved* before hardware exists, because
boards are in transit and "done" for this plan was defined as cross-build green **plus**
host tests, not desk-checking.

The seam is a transport vtable and an injected clock. Above it, the entire §10 state
machine is pure C. Below it, mbedTLS and lwIP on the device, or a scriptable fake on the
host.

| File | Role | Runs on host? |
|---|---|---|
| `device_client.c/.h` | **New.** The whole §10 state machine. | yes |
| `transport.h` | **New.** `connect/write/read/close` + clock. The seam. | — |
| `transport_tls.c` | **New.** mbedTLS over altcp_tls. | no |
| `transport_fake.c` | **New.** Scripted responses, injectable faults. | test only |
| `http.c/.h` | **New.** Request builder, response parser, body framing. | yes |
| `token_store.c/.h` | **New.** Flash on device, memory on host. | yes |
| `sntp_time.c` | **New.** Wall clock for certificate validity. | no |
| `psram_image.c/.h` | **Modify.** Two slots; injectable backing. | yes |
| `image_loader.c` | **Modify.** Both defect fixes; targets a named slot. | yes |
| `http_fetch.c` | **Delete.** Its `/tracks/<n>` model is superseded whole. | — |

**The rule that keeps the seam honest:** `device_client.c` may not include an SDK or lwIP
header. If it ever needs one, the seam is in the wrong place and the fix is to move the
seam, not to add the include. This is stated as a rule because it is the single property
that makes the rest of this plan verifiable, and it degrades silently — one `#include`
and the state machine stops being host-testable, with nothing failing to announce it.

`http_fetch.c` is deleted rather than adapted. Its shape — one blocking fetch of a
path-addressed track from a bare IP, header scan discarded, no status line parsed — has no
part of it that survives contact with §10.

## 4. The state machine

```
UNPROVISIONED ──register──> IDLE_POLL ──200 desired──> FETCHING
                                 ^                        │
                                 │                     verified
                                 │                        v
                              SWAPPING <──────────────  VERIFYING
```

Plus `BACKOFF` (retryable failure, re-entered from any network state) and `HALTED`
(`401` anywhere, or `404` on poll).

### 4.1 `since` — the two rules that produce a permanently diskless device if broken

**`since = 0` on every cold boot, always, and it lives only in RAM.** §10 spends its
longest paragraph on this and it is worth restating: PSRAM is lost on power-cycle, so
"what this device has already been told" is lost with it. A `since` persisted in flash and
replayed after a power-cycle earns `204` for up to 25 s at a time, forever, with no error
and no retry that helps.

`since` therefore lives in `device_client`'s RAM state and nowhere else. The token, which
*must* survive a power-cycle, lives in `token_store`. The hazard is that these are the two
pieces of long-lived device identity and it is natural to reach for one module for both —
so `token_store.h` carries an explicit note that `since` must never be added to it, next
to the function that would be the obvious place to add it.

**`since` advances only after the transition it names has completed** — not on receipt of
the response that named it. Receiving `{version: 7, ...}` does not make `since` 7. The
fetch must have succeeded, the image verified, and the slot swapped. On failure the device
re-polls with the *old* `since`, and the server redelivers the same instruction. That
idempotent redelivery is what makes this reconciliation rather than a job queue.

### 4.2 Status codes

Transcribed from §10, one host test per row. The rows that are not obvious, and are
therefore the ones a reimplementation gets wrong:

- **Poll `404`** — the device row is gone from the server. **Keep the disk mounted** and
  stop polling. A deleted row is an absence of signal, and §2 rule 1 forbids an absence
  from ejecting anything.
- **Image `404` / `422`** — not entitled, or permanently unencodable. Never retry *this
  digest*; keep polling, because the desired state may change to something fetchable.
- **Image `400`** — a firmware bug (malformed digest). Never retry as-is; it will not
  become valid by resending.
- **`401` anywhere** — the token is dead. Stop. In 4a that is `HALTED` plus a log line; 4b
  makes it re-enter provisioning.

### 4.3 Timing

- **Socket read timeout ≥ 30 s.** The poll holds 25 s before answering `204`. A 10 s
  default — common in embedded HTTP clients — tears down every poll mid-hold and looks
  exactly like a network fault, driving a healthy device into permanent backoff. A test
  asserts the configured timeout exceeds the hold.
- **Backoff** exponential from 1 s to a cap, with jitter, on connection failure and 5xx.
  Driven by the injected clock, so tests assert the sequence without waiting. The server
  sends no `Retry-After`.
- **Status heartbeat** ~60 s and on every transition, sending all **six** fields
  (`mountedSha256`, `mountedDiskId`, `version`, `error`, `psramFree`, `rssi`) every time.
  Partial reports no longer destroy omitted columns after F-2, but they do leave the UI
  showing stale values. *(§10's heading says "all five status fields" and then enumerates
  six. Six is right — the list is authoritative, the heading is a miscount. Corrected in
  §10 alongside this spec so a firmware author does not have to guess which is meant.)*
- **No `Range` support** on the image endpoint. A drop mid-transfer restarts the whole
  body from zero; the timeout budget must account for a full retransfer, not one attempt.
  Two different sizes appear in these specs and both are correct: **2,027,536 bytes** is
  the `WFMF` wire size, while **2,129,920** is the PSRAM *slot allocation*
  (160 × 13,312). Transfer budgets use the former; slot arithmetic uses the latter.

## 5. PSRAM slots

8 MB holds three 2,129,920-byte images. 4a uses two, addressed by index rather than the
current single implicit image.

Core1 fetches into the **inactive** slot and verifies magic, version, `track_count` and
every per-track bit count before publishing. Publication is a single store to a
`volatile` word-aligned `active_slot`, which core0 reads on each `track_cache_get` — a
naturally-aligned 32-bit access, so no lock and no torn read. Because a swap only ever
moves between two *complete, verified* images, a swap landing between two track reads is
safe by construction: core0 sees either the old disk or the new one, never a partial one.

Eject is the same mechanism with `active_slot = NONE`. That makes `desired: null` an
ordinary transition rather than a special case — which matters, because the special case
is where an unasked eject would hide.

## 6. TLS, and the two things that make it not work

### 6.1 The insecure default

`ALTCP_MBEDTLS_AUTHMODE` defaults to **`MBEDTLS_SSL_VERIFY_OPTIONAL`** in the pico-sdk.
Under that default a handshake against *any* certificate completes and returns success.
That is functionally `setInsecure()` — the exact upstream behaviour D5 cited as a reason
not to use `Gotek_WiFi_Dongle`, arriving here through a default nobody set.

It is invisible when wrong: the fetch works, the disk mounts, nothing logs. So it gets
two defences, not one — `ALTCP_MBEDTLS_AUTHMODE=MBEDTLS_SSL_VERIFY_REQUIRED` in CMake,
**and** an `#error` guard in a firmware header if the macro is undefined or not
`REQUIRED`, so a later CMake edit cannot silently restore it. A comment would not have
been enough; this is a silent-fallback bug of exactly the class this project has been
bitten by twice.

### 6.2 There is no clock

Certificate validity cannot be checked without wall time, and the RP2350 has no
battery-backed RTC — every cold boot starts with no idea what year it is.

SNTP runs after association and **before the first handshake**. If it fails, the device
retries with backoff and **does not attempt TLS at all**. It stays diskless rather than
skipping expiry validation. Under §2 that is the correct side of the trade: an outage is
allowed to cost disk *swapping*, and a device that quietly downgrades its own certificate
checking to stay online is worse than one that waits and says so.

### 6.3 Trust anchors

Measured against production rather than assumed: `*.vercel.app` is served by **Google
Trust Services WR1**, chaining to **GTS Root R1** (itself cross-signed by GlobalSign Root
CA), over TLS 1.3 / `TLS_AES_128_GCM_SHA256`, with a 90-day leaf. Pinning a leaf is
therefore impossible and pinning one root is fragile — Vercel has used Let's Encrypt
before, and a CA change would silently strand every deployed board.

A curated multi-root bundle ships instead: GTS Root R1, ISRG Root X1, DigiCert Global
Root G2, Amazon Root CA 1, GlobalSign Root CA. Generated into `roots.h` by a script from
pinned PEMs, each with its SHA-256 fingerprint in a comment, so "what does this firmware
trust" is answered by reading one file. This also buys the freedom to move webadf to a
custom domain without a reflash.

`WEBADF_HOST` is a compile-time define used for both SNI and the `Host` header.

## 7. Provisioning in 4a

Compile-time: `WIFI_SSID`, `WIFI_PASS`, `WEBADF_HOST`, `WEBADF_PAIRING_CODE`.

On boot with no stored token, the device posts to `/api/device/register` —
`{pairingCode, firmwareVersion, macAddress}`, deliberately unauthenticated server-side,
the code itself being the credential — and persists the returned token to flash. The whole
server side of this already exists and is tested; 4a is its first real client.

4b replaces only *where those four values come from*. Nothing else about this section
changes when the captive portal lands, which is what makes the split clean.

### The flash-versus-real-time-bus constraint

Writing the token writes flash, which disables XIP. Core0's DMA IRQ — which re-arms the
transfer each revolution and raises INDEX — executes from flash, and would stall
mid-revolution. The Amiga would see a malformed revolution: a flaky drive, essentially
undiagnosable without a scope, and intermittent by nature.

Two mitigations, both cheap, both applied: flash writes happen **only in `REGISTERING`,
before any disk is mounted**, and the DMA IRQ handler moves into RAM with
`__not_in_flash_func`. Either would likely suffice. The failure they prevent is bad enough,
and rare enough to be attributed to hardware, that belt and braces is the right call.

## 8. The two recorded defects

Both from `2026-08-29-adfmfm-encoder-design.md` §7, found while building the encoder.

**Buffer overflow.** `TRACK_SLOT_BYTES` (13,312, PSRAM) and `TRACK_MFM_MAX` (13,000, SRAM)
collapse into a single constant used by both, and the loader rejects any track exceeding
it. Latent today only because real tracks are 12,668 bytes.

**`bit_count` overflow.** `image_loader.c:51` computes `(bits + 7) / 8` on a `uint32_t`; a
`bit_count` at or above `0xFFFFFFF9` wraps to `payload_bytes = 0` and sails past the
`> TRACK_SLOT_BYTES` guard. Every track then parses as present with a nonsense bit count
and the firmware presents a disk of empty tracks instead of refusing the image. Bound
`bits` **before** the arithmetic.

### The mirror must move with it

`src/lib/adfmfm/firmware-parser.ts` **deliberately reproduces the second defect**, and
HANDOFF says not to "fix" it. That instruction is correct *while the firmware is broken* —
the mirror's job is to model what the device actually accepts, warts included, and the
asymmetry against the hardened `readWfmf` is intentional and load-bearing.

Once the firmware is fixed, the mirror models a device that no longer exists. So the fix
and the mirror update land **in the same change**: update `firmware-parser.ts`, update the
asymmetry assertions in `wfmf.test.ts`, and rewrite the comments explaining why the two
parsers now agree where they previously diverged. Doing the firmware half alone leaves a
green test suite asserting that the firmware is still broken — which is worse than either
state on its own, because it looks like coverage.

## 9. Verification

Boards are in transit, so nothing here is verified on hardware. "Done" is a green ARM
cross-build **plus** a green host suite.

`firmware/test/`, plain C compiled with clang, an assert harness of a few dozen lines and
no framework — the same dependency-free posture as `adfmfm`, and it keeps the test
question independent of the toolchain question. Run by `pnpm firmware:test`.

Covered: every §4.2 status-code row; both §4.1 `since` rules; backoff sequencing against
the injected clock; the HTTP response parser; `image_loader` against randomly-chunked and
malformed input; slot swap and eject. The two that matter most, because they are the
forbidden failure modes of §2:

- A connection dropped 60% through a fetch leaves the mounted disk untouched and re-polls
  with the **old** `since`.
- A poll `404` keeps the disk mounted.

Project discipline applies unchanged: **watch every test fail before making it pass**, and
**prove every defect fix with a mutation** — break it, watch a *named* test fail, revert.

### Two things to verify, not assume

Both cheap, both the class of assumption that changed this project's design three times:

1. **Does pico-sdk 2.x ship a `pimoroni_pico_plus2_w_rp2350` board header?** `CMakeLists`
   already names it and relies on it to supply `PICO_PSRAM_CS_PIN` and
   `PICO_PSRAM_SIZE_BYTES`. If it is absent, vendor the header.
2. **Does `/api/device/image/<sha256>` respond with `Content-Length` or chunked
   encoding?** A live probe against the real endpoint. The parser must handle whichever it
   actually is, and 2 MB is exactly the size where a platform may choose either.

## 10. Out of scope

Not built here: the captive portal, DHCP/DNS and flash-backed credentials (**4b**);
hardware bring-up, PIO timing validation and anything requiring a scope or an Amiga
(**plan 5**); write-back, `http_post_track`, and the dirty-track flush walker (backlog,
still undesigned — disk-change spec §5); resident multi-disk sets (§9 of that spec,
additive and deliberately not precluded).

**Not fixed here, and deliberately:** `BITCELL_NS` is 2,000 ns against a true Amiga
bitcell of 1,973.6 ns, giving ~296 RPM against a nominal 300. Accepted — the Amiga's PLL
locks to sync marks rather than a stopwatch, and real drives vary by more. It is a
one-line `clkdiv` trim in `flux_out_program_init` if hardware ever says otherwise, and
plan 5 is where that evidence would come from.
