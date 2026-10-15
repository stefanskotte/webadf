# Board server override (self-hosting) -- design

**Date:** 2026-10-15. **Status:** operator's answers folded in (2026-10-15): no plain HTTP; self-signed HTTPS with a
lax name check is fine; changing the server means pairing again.
**Source:** HANDOFF backlog "an override config ON THE BOARD" (operator, 2026-10-14); the operator chose a USB serial
command over a USB drive file (2026-10-15), because the board exposes no USB drive today (USB is CDC serial only).

## 1. What it is for

Someone hosting their own copy of the web app points their board at it. Without an override nothing changes: the
board talks to the compiled-in `webadf.vercel.app` on port 443 over TLS, verified against the compiled-in roots
(`src/roots.h`), exactly as today.

## 2. Decisions proposed

| # | Decision |
|---|---|
| D1 | Set **only over the USB serial port** (the cable already used for logs). Physical access is the trust boundary. Never from the Wi-Fi setup portal, the server, or NFC. |
| D2 | Stored in **its own flash sector** (magic + CRC, the `config_store.c` pattern), apart from Wi-Fi credentials and the device token. Survives OTA updates; erased only by `wf server clear`. |
| D3 | Fields: **host**, **port** (default 443), **TLS mode** `verify` (default: the compiled-in roots and the host name) or `noverify` (any certificate, self-signed included, and no host-name check -- for a home server). **Always TLS: there is no plain-HTTP mode** (operator, 2026-10-15). |
| D4 | **Changing the server forgets the pairing** (operator, 2026-10-15). The device token belongs to the old server, so a change clears the token (Wi-Fi is kept) and the board opens its setup portal for a pairing code from the new server. `wf server clear` does the same in reverse. |
| D5 | **A weakened setting is never silent.** `noverify` shows a fixed marker on the OLED's status line ("INSECURE"), is logged at every boot and every connect, and the status report carries `server: {custom, tls}` so the card shows "Custom server" and, for `noverify`, "Certificate not checked". A custom server with `verify` shows "Custom server" only. |
| D6 | **Firmware updates stay ours.** The board still checks every update's signature against its compiled-in key, so a custom server can only offer builds signed by us; a self-hoster who builds their own firmware flashes it over USB. |
| D7 | Applied at the **next boot**; `wf reboot` is offered. One code path at boot reads the override (or the defaults) into the transport and `dc_init` -- no live switching mid-session. |

## 3. Serial commands

Typed into the USB serial console (`screen`, the Arduino serial monitor, or `wf-cli` later). One line each; the board
answers with one `server:` line, so a script can check it.

```
wf server show                               -> server: default webadf.vercel.app:443 tls=verify
wf server set https://my.host[:port]         -> TLS verify (the default); http:// is refused
wf server tls noverify                       -> self-signed / any name; asks "type YES to confirm"
wf server tls verify
wf server clear                              -> back to the default; pairing forgotten
wf reboot
```

Every change prints what the board will do at the next boot and that the pairing will be forgotten.

## 4. Firmware pieces

- `override_store.c/.h`: the sector (host <= 63, port, tls mode), host-tested like `config_store`.
- `serial_cmd.c/.h`: a line reader on core1's loop (non-blocking `getchar_timeout_us(0)`, as the bench `fwdbg`
  reader), and a pure command parser that is host-tested. Release builds include it (unlike `fwdbg`).
- Transport: `transport_tls.c` takes the authmode from the override (`noverify` = `MBEDTLS_SSL_VERIFY_NONE`, which
  also skips the host-name check; SNI is still sent). `device_client` gets the port
  (today a literal 443 in `device_client.c`) and builds `Host:` with the port when it is not the default.
- OLED marker and status-report key (D5); the server stores and shows them (`devices.server_custom`, `server_tls`).

## 5. Server pieces

- The status route accepts `server: {custom: bool, tls: 'verify'|'noverify'}`; two columns; the card line.
- Nothing else changes: a self-hosted server is this same code.

## 6. Out of scope

Plain HTTP; a pinned CA or certificate fingerprint (a stronger middle ground than `noverify`, later if asked);
setting the server from the setup portal; a server list or fallback; mutual TLS; changing the signing key.

## 7. Testing

- Host tests: the store (round trip, CRC, erased), the command parser (each command, the YES confirmation, bad
  URLs, `http://` refused), the authmode per mode, `Host:` with a port.
- Server: vitest for the status key; e2e for the card line (touched specs only).
- Bench: point the board at a local HTTPS server with a self-signed certificate (e.g. `pnpm dev --experimental-https`
  on the Mac, `noverify`), see INSECURE on the OLED and "Certificate not checked" on that server's card, pair, mount
  a disk; then `wf server clear` and re-pair to production.

## 8. Answered (operator, 2026-10-15)

1. Changing the server forgets the pairing: yes, re-pair.
2. Plain HTTP: no. Self-signed HTTPS with a lax name check: yes (`noverify`).
