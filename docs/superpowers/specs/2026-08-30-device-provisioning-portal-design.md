# Device provisioning — AP-mode captive portal (plan 4b)

**Addendum to `2026-08-23-webadf-design.md`.** That spec remains the binding authority.
This one completes the split declared in `2026-08-30-device-firmware-protocol-design.md` §7:
plan 4a shipped the protocol plane with credentials as compile-time defines, and said 4b
would replace *only where those values come from*. This is that plan.

**Scope:** provisioning only. How a board learns its WiFi credentials and its pairing code
without a rebuild. Nothing about the device protocol, TLS, PSRAM or the floppy bus changes.

**Status: not started.** Boards are still in transit, so — exactly as in 4a — nothing here
will run on hardware, and "done" means a green cross-build plus a green host suite.

---

## 1. What 4a left, and what this replaces

Four compile-time defines, consumed at three places in `core1_main`:

| Define | Used at | 4b |
|---|---|---|
| `WIFI_SSID`, `WIFI_PASS` | `main.c:196` (`cyw43_arch_wifi_connect_timeout_ms`) | from flash |
| `WEBADF_PAIRING_CODE` | `main.c:229` (`dc_register`) | from flash |
| `WEBADF_HOST` | `main.c:228`, `:244` (`dc_init`) | **stays compile-time** |

`WEBADF_HOST` is deliberately not made editable — see §9.

4a also leaves a working pattern to follow: `token_store.c` already does flash persistence
correctly on this board, including the constraint that a flash write disables XIP and can
stall core 0's DMA IRQ mid-revolution. `config_store` follows it rather than inventing a
second approach.

## 2. The property this plane must preserve

Inherited from the disk-change spec §1 and unchanged: **losing the webservice degrades disk
swapping, not disk serving.** Provisioning adds a new way to be offline — a board sitting in
AP mode is, by definition, not talking to webadf — so one rule follows directly:

> **A board that is already serving a disk never drops into the portal.**

The portal is reachable only before a disk is mounted: at boot, or after association has
failed. A device happily serving an Amiga does not interrupt itself to offer a config page,
whatever the network is doing. This also keeps the existing flash-write guard honest — the
portal's only flash write happens while `psram_active_slot() == SLOT_NONE`.

## 3. Decisions taken, with reasoning

**D-4b-1 — The portal opens when there are no stored credentials, OR after three
consecutive failed associations.** An *attempt* is one
`cyw43_arch_wifi_connect_timeout_ms()` call with a 15-second timeout — the value 4a already
uses — so three failures is roughly 45 seconds of trying, not three instantaneous retries.
Recovery matters more than simplicity here: this
hardware has no console and no spare button, so "unprovisioned only" would make a changed
router password an unrecoverable state requiring a reflash of every board. The cost is that
an extended router outage eventually parks a board in AP mode; §2's rule bounds the damage,
since a board with a disk mounted stays mounted.

**The failure counter is RAM-only.** Same reasoning as 4a's `since`: a power-cycle should
restore patience. A flash-resident counter would accumulate across reboots and eventually
push a healthy board into AP mode permanently, which is the sort of failure that looks like
dead hardware.

**D-4b-2 — The AP is WPA2 with a fixed compile-time password.** An open AP would accept
anyone's WiFi credentials and anyone's pairing code, which hands them the board. That risk
is larger here than in the usual first-boot-only design, because D-4b-1 can leave the AP up
for as long as the router is down. A per-board password derived from the MAC was considered
and rejected as more ceremony than the operator's own boards warrant; a single
`PORTAL_AP_PASSWORD` in the image closes the drive-by case, which is the one that matters.
The SSID carries a MAC suffix (`wifi-floppy-AB12`) so several boards on a bench are
distinguishable.

**D-4b-3 — Verify, then commit.** On submit the AP drops, the board attempts association
with the submitted credentials, and flash is written **only** on success; on failure the AP
returns with the reason. The alternative — store and reboot — turns a typo into a board that
can only be recovered by waiting out D-4b-1's failure count, which is slow and reads as a
malfunction. The cost is one AP-down/AP-up cycle and a reconnect from the phone.

The pairing code is **not** redeemed as part of this check. Codes are single-use with a
10-minute TTL, so a redeem that succeeds and is then lost to a crash before the token is
stored would burn the code and strand the board.

**D-4b-4 — An expired or used pairing code is terminal and returns to the portal.**
This is new behaviour, and it exists because 4b changes the code's lifetime. In 4a the code
was compiled in and redeemed within seconds of boot, so `400 invalid_or_used_code` was
effectively unreachable. Now the code sits in flash and can be redeemed much later — a board
provisioned and then left powered off past the TTL will fail permanently. 4a's register loop
treats a 400 as retryable and backs off to a 60-second cap, so such a board would retry a
dead code forever with no way to say so. Under 4b that specific error drops to the portal so
a fresh code can be entered.

**Re-provisioning erases the stored token.** Re-pairing creates a new device row server-side
and issues a new token; keeping the old one would leave the board authenticating as a device
the server no longer associates with these credentials.

*This does not contradict §2's rule.* Registration only ever runs before a disk is mounted —
a token is a precondition for polling, and polling is a precondition for fetching an image —
so the `RUNNING → PORTAL` edge above can never fire while the Amiga is being served. The
state machine in §5 shows the edge leaving `RUNNING`, but the only part of `RUNNING` that can
take it is the registration step at its start.

## 4. Architecture

The seam is the same one that made 4a provable: pure logic over byte buffers, with a thin
binding that owns the socket. Every protocol module splits in half.

| File | Role | Host-testable |
|---|---|---|
| `src/config_store.c/.h` | SSID, password, pairing code in flash | yes |
| `src/provisioning.c/.h` | The state machine of §5. Pure. | yes |
| `src/dhcp_server.c/.h` | `dhcp_handle()` pure; UDP binding separate | pure half |
| `src/dns_server.c/.h` | `dns_handle()` pure; UDP binding separate | pure half |
| `src/portal_http.c/.h` | `portal_request()` pure; page and form | pure half |
| `src/portal_net.c` | All lwIP/cyw43 glue: AP up/down, sockets, listener | no |
| `src/main.c` | **Modify.** Provisioning phase ahead of 4a's loop | — |
| `CMakeLists.txt` | **Modify.** Drop three defines, add `PORTAL_AP_PASSWORD` | — |

**`provisioning.c` and the pure half of each server may not include an SDK or lwIP header.**
`portal_net.c` is the only file that touches the radio. This is the property that makes the
rest testable and it degrades silently, exactly as in 4a — one include and nothing announces
the loss.

Writing the three servers was chosen over vendoring `pico-examples`' `dhcpserver.c` and
`dnsserver.c` (which are not present on this machine and would add a clone) plus lwIP's
`httpd`. Those are proven, but all three are callback-shaped and none can be exercised on the
host; for this use case each is small and almost entirely pure byte-shuffling, which is the
ideal shape for tests. With no hardware to try things on, code that can be exercised beats
code that can only be read.

## 5. The state machine

```
boot → config_store_load
  ├─ nothing stored ─────────────────→ PORTAL
  └─ stored → associate (≤3 attempts)
       ├─ success ──────────────────→ RUNNING (4a's loop unchanged)
       └─ 3 consecutive failures ───→ PORTAL

RUNNING → register returns 400 invalid_or_used_code → PORTAL   (D-4b-4)

PORTAL (AP up, WPA2) → submit
  → AP down → associate with submitted credentials
      ├─ success → config_store_save → RUNNING
      └─ failure → AP back up, form redisplayed with the reason
```

`RUNNING` is 4a's `core1_main` loop, entered unmodified once credentials exist.

## 6. The three servers

**DHCP.** A two-entry lease pool on `192.168.4.0/24` with the board at `.1`. Handles
DISCOVER→OFFER and REQUEST→ACK; ignores everything else.
`int dhcp_handle(const uint8_t *req, int len, uint8_t *out, int cap)` returns bytes to send,
or 0 for "no reply". Tested against real DISCOVER and REQUEST frames, plus truncated,
oversized, and wrong-op-code inputs.

**DNS.** Answers every A query with `192.168.4.1`. That blanket redirection is what makes the
captive portal appear at all rather than the phone reporting a network with no internet.
Same pure shape. Tested against a normal query, a compressed name, a query with no question
section, and a malformed length field.

**HTTP portal.** Three routes: `GET /` renders the form, `POST /save` decodes
`application/x-www-form-urlencoded`, and **every other path 302-redirects to
`http://192.168.4.1/`**. The catch-all is the mechanism: iOS probes
`captive.apple.com/hotspot-detect.html` expecting the literal body `Success`, and Android
probes `/generate_204` expecting a 204 — answering either with a redirect is what makes the
OS open the sign-in sheet.

The page is self-contained: inline styles, no external CSS or fonts, because the AP has no
route to the internet and a page blocking on a CDN would look broken. It displays the
board's MAC so multiple boards are distinguishable, never echoes a stored password back into
the form, and on failure distinguishes *wrong password* from *SSID not found* — the cyw43
return tells them apart, and they call for different corrections.

**Named limitation:** whether those probe URLs actually trigger the sign-in sheet **cannot be
verified without hardware**. The parsing, routing and form decoding are host-tested; the
OS-behaviour half belongs to plan 5.

## 7. Storage

A dedicated flash sector immediately below `token_store`'s, which occupies the top sector
(`PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE`, on a 16 MB part). `config_store` takes
`PICO_FLASH_SIZE_BYTES - 2 * FLASH_SECTOR_SIZE`.

Record: `magic(4) · version(1) · ssid_len · pass_len · code_len · ssid · password · code ·
crc32(4)`. An SSID is at most 32 bytes by 802.11, a WPA2 passphrase 8–63, a pairing code 6 —
so the record fits inside a single 256-byte program page.

**The CRC is deliberate and is a correction, not decoration.** Plan 4a's review left a
deferred finding that `token_store`'s magic sits at offset 0, so it detects a write that
never started but not one that corrupted only the payload. Credentials are more exposed to
that failure than a token, because they are written at the end of an interactive flow where
someone may pull the power. A trailing CRC over the whole record closes it. `config_store`
gets this from the start rather than inheriting a known weakness; retrofitting `token_store`
is out of scope here and stays on the deferred list.

Both stores keep the mounted-disk guard from 4a: no flash write while
`psram_active_slot() != SLOT_NONE`. §2's rule means the portal can never violate it.

## 8. Verification

Boards are in transit. **Done means a green ARM cross-build plus a green host suite** — the
same bar as 4a, and for the same reason.

Host-tested: `config_store` round-trip, torn write, and CRC mismatch; the state machine
(portal on no config; portal after exactly three failures and not two; counter reset on
success; commit strictly after a successful associate; terminal `400`); and the pure half of
all three servers against valid and malformed packets.

Two requirements carried directly from 4a's failures, both of which cost that plan a fix
round:

- **The link gate must be non-vacuous.** 4a's Critical was that the whole TLS stack was
  discarded by `--gc-sections` while the build stayed green, because nothing called it.
  `portal_net.c` gets the same `-Wl,-u` treatment, and the plan must **prove the symbols are
  in the ELF** rather than infer it from a successful link.
- **Core 1's stack must be re-measured, and the new margin stated.** 4a sized it at 16 KB
  against a measured ~5.3 KB worst case dominated by the TLS handshake. 4b adds a DHCP
  server, a DNS responder and an HTTP server to that same core. The AP phase and the TLS
  phase never overlap, so the peak is probably still the handshake — but "probably" is
  precisely what produced 4a's silent heap corruption, and the MSPLIM guard turns a wrong
  guess into a hard fault rather than corruption only if the number is right.

## 9. Out of scope

`WEBADF_HOST` stays compile-time: it changes only if the deployment moves, and making it
portal-editable would let anyone who reaches the AP point the board at a server of their
choosing — a real attack surface for a capability nobody needs.

Also excluded: multiple stored networks; mDNS or a friendly hostname; retrofitting
`token_store` with a CRC; and all hardware validation, which is plan 5's — including whether
the iOS and Android captive-portal probes actually trigger the sign-in sheet, and whether
WPA2 AP mode and STA mode transition cleanly on this radio.
