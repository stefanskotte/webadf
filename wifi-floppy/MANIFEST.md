# wifi-floppy — what is in this folder

WiFi floppy emulator for the Amiga: a Pimoroni RP2350 module presents itself as
a 34-pin Shugart floppy drive and serves whole disk images out of PSRAM.

`README.md` is the design narrative and the errata. This file is only the map.

    README.md          design notes, decisions, the revision history and the
                       rev A/A2 errata (rev B is current, not yet fabricated)
    INTEGRATION.md     at the REPO ROOT, not here — the /image/<sha256> wire
                       format and how the firmware talks to webadf
    .gitignore         build output, regenerable Gerbers, hardware/.venv

## firmware/ — RP2350, `PICO_BOARD=pimoroni_pico_plus2_w_rp2350`

**The module is a Pimoroni PIM726, and the part number is a requirement.**
`psram_image.c` is a 2.03 MB store in that board's PSRAM and it is how a disk
gets served at all — a pin-compatible module without PSRAM fits the footprint
and then does not work.

    CMakeLists.txt      PORTAL_AP_PASSWORD must be set in the environment or
                        the configure step fails BY DESIGN — an empty WPA2 PSK
                        cannot be reported back to a console-less board
    src/main.c          core 0 = floppy bus real-time, core 1 = WiFi + loading
    src/floppy.pio      2 us MFM bitcell out, edge-interval capture in
    src/dskchg.c        /CHNG, /RDY and the drive-ID shifter
    src/mfm.c           decode helpers; write-back is still a skeleton
    src/psram_image.c   2.03 MB image store, two slots, fetch before transition
    src/track_cache.c   SRAM double buffer — the only DMA source
    src/wf_log.c        USB-CDC console log for bring-up. wf_logf() formats;
                        wf_trace() takes an integer event code, so it is legal
                        inside the flux DMA handler where a flash-resident
                        format string is not. core0 drains, core1 only produces
    src/image_loader.c  streams a WFMF image into PSRAM at mount

    the device protocol (plan 4a)
    src/device_client.c the §10 state machine: poll, fetch, report status
    src/transport_tls.c mbedTLS; src/roots.h is generated, src/tls_guard.h
    src/token_store.c   the provisioned bearer token, in its own flash sector
    src/http.c, json_scan.c  minimal client and parser

    the captive portal (plan 4b)
    src/portal_net.c    AP mode when unprovisioned, or after 3 failed joins
    src/portal_http.c   the config form
    src/config_store.c  CRC-protected flash sector below the token's
    src/provisioning.c  verifies credentials BEFORE writing them to flash
    src/dhcp_server.c, dns_server.c   what makes the captive portal captive

    test/run.sh         506 checks over 13 binaries, plain C under clang.
                        No toolchain, no SDK, no env vars. `pnpm firmware:test`

**WIFI_SSID / WIFI_PASS / WEBADF_PAIRING_CODE ARE GONE.** Plan 4b replaced the
compile-time defines with the AP-mode portal above; any document or comment
still describing them is stale. `WEBADF_HOST` stays compile-time deliberately —
letting anyone who reaches the AP repoint a board at a server of their choosing
is a real attack surface nobody needs.

## hardware/

    generate_pcb.py    emits wifi_floppy.kicad_pcb + a built-in DRC-lite pass.
                       THE BOARD IS GENERATED: edit this, never the .kicad_pcb
    export_gerbers.py  Gerber + Excellon; computes the B.Cu pour geometry.
                       Needs shapely — use ./.venv/bin/python
    render_pcb.py      pcb_render.svg
    verify_board.py    RUN BEFORE ANY FAB ORDER — `pnpm hw:verify`
    stroke_font.py     single-stroke vector font, so the exporter can put
                       reference designators on the silkscreen at all
    ref_footprints/    canonical KiCad land patterns to compare against
    bom.csv            regenerated with the board

**The first revision came back MIRRORED and was scrapped.** `verify_board.py`
exists to catch that class of mistake, and checks four things: that no footprint
is a reflection of its canonical land pattern, that the exported Gerber is
correctly Y-flipped (Gerber is Y-up, KiCad is Y-down), that the antenna keepout
void is at the antenna end of U1, and that no silkscreen feature is below the
fab's minimum width. The last two are read back out of the emitted Gerbers
rather than re-derived from the exporter, because each of those three failures
reached a fabricated board.

Two limits it states about itself rather than hiding: a mirror-symmetric part
(0603, 0805, SMA, 1x04 header) cannot fail a chirality test at all, and U1's
module footprint has no upstream reference and must be checked by hand.

Only **U2** carries silkscreen — the buffer IC is the one part that can be
fitted the wrong way round without it being obvious. Caps and SOT-23s are
deliberately bare.
