cmake_minimum_required(VERSION 3.13)
include(pico_sdk_import.cmake)

# hardware_psram (psram_get_size/psram_is_available/psram_check_address, and
# the __uninitialized_psram section macro used by src/psram_image.c) does not
# exist before pico-sdk PR #2919, which landed after the 2.2.0 release. This
# board's header also only gained the PICO_PSRAM_CS_PIN / PICO_PSRAM_SIZE_BYTES
# mapping at that point. First SDK tag with all of this: 2.3.0. Older SDKs fail
# at link time with "cannot find -lhardware_psram" or similar, far from here -
# catch it up front instead.
if (PICO_SDK_VERSION_STRING VERSION_LESS "2.3.0")
    message(FATAL_ERROR
        "wifi_floppy requires pico-sdk >= 2.3.0 (found ${PICO_SDK_VERSION_STRING}). "
        "hardware_psram, and this board's PICO_PSRAM_CS_PIN/PICO_PSRAM_SIZE_BYTES "
        "board-header support, were not added until pico-sdk 2.3.0. "
        "Point PICO_SDK_PATH at a pico-sdk checkout of tag 2.3.0 or later.")
endif ()

project(wifi_floppy C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(PICO_BOARD pimoroni_pico_plus2_w_rp2350)   # RP2350B + RM2(CYW43) + 8MB PSRAM
# Board header supplies PICO_PSRAM_CS_PIN=47 and PICO_PSRAM_SIZE_BYTES=8MB,
# so the SDK runtime brings PSRAM up before main().
pico_sdk_init()

# WFMF_OMIT_AUTHMODE exists for exactly one purpose: proving src/tls_guard.h's
# #error actually fires when ALTCP_MBEDTLS_AUTHMODE isn't forced to
# MBEDTLS_SSL_VERIFY_REQUIRED. It must never be turned on for a real build --
# see task-9-brief.md Step 3 for the guard-test invocation, which builds a
# throwaway build-guardtest directory and expects the build to FAIL.
option(WFMF_OMIT_AUTHMODE
  "Test-only: omit ALTCP_MBEDTLS_AUTHMODE to prove src/tls_guard.h's #error fires. Never enable for a real build." OFF)

# Review round 1 finding (Critical, C1): mbedtls_config.h enables
# MBEDTLS_PSA_CRYPTO_C (required by MBEDTLS_SSL_PROTO_TLS1_3 -- see
# mbedtls_config.h's own comment on that), but pico-sdk 2.3.0's
# pico_mbedtls/CMakeLists.txt's src_crypto_list() omits
# library/psa_crypto_random.c from the mbedtls-3.x file list even though
# psa_crypto.c calls four functions defined only there
# (psa_random_internal_{init,seed,generate,free}). The first build of this
# task passed only because nothing in the executable referenced
# tls_transport()/sntp_sync_blocking() yet, so --gc-sections discarded
# transport_tls.c/sntp_time.c (and, transitively, everything in mbedtls
# they alone would have pulled in) before the missing symbols ever came up
# at link time -- "cross-build green" proved nothing about this task.
# Smallest fix that keeps TLS 1.2+1.3/secp256r1 exactly as verified against
# the live host in task-9-report.md: add the one missing SDK source file
# directly, rather than dropping MBEDTLS_PSA_CRYPTO_C (which would also
# force dropping MBEDTLS_SSL_PROTO_TLS1_3, per check_config.h).
# PICO_MBEDTLS_PATH is set the same way PICO_LWIP_PATH already is used
# below: promoted to this scope by pico_mbedtls's own CMakeLists.txt during
# pico_sdk_init() above.
set(WFMF_PSA_CRYPTO_RANDOM_SRC ${PICO_MBEDTLS_PATH}/library/psa_crypto_random.c)

add_executable(wifi_floppy
  src/main.c src/dskchg.c src/track_cache.c src/psram_image.c
  src/image_loader.c src/device_client.c src/http.c src/json_scan.c
  src/token_store.c src/config_store.c src/provisioning.c
  src/mfm.c src/write_back.c src/dns_server.c src/dhcp_server.c src/portal_http.c
  src/portal_net.c
  src/transport_tls.c src/sntp_time.c
  ${WFMF_PSA_CRYPTO_RANDOM_SRC}
  src/wf_log.c
  src/activity_led.c src/i2c_probe.c src/ssd1306.c src/display.c
  src/flux_capture.c src/flux_bits.c
  src/bus_gate.c src/bus_out.c
  src/sha256.c
)
pico_generate_pio_header(wifi_floppy ${CMAKE_CURRENT_LIST_DIR}/src/floppy.pio)
target_include_directories(wifi_floppy PRIVATE src ${CMAKE_CURRENT_LIST_DIR})
# Task 6: the provisioning AP's own address. cyw43_arch_enable_ap_mode()
# (portal_net.c) brings the interface up; this is what makes it come up as
# 192.168.4.1 specifically, matching dns_server.h/dhcp_server.c's PORTAL_IP_*
# identity, rather than in code -- pico_cyw43_driver's own CMakeLists.txt
# documents this exact macro/target-type/define-name/address-string shape.
pico_configure_ip4_address(wifi_floppy PRIVATE CYW43_DEFAULT_IP_AP_ADDRESS 192.168.4.1)
target_link_libraries(wifi_floppy
  pico_stdlib pico_multicore hardware_pio hardware_dma hardware_irq
  hardware_psram hardware_sync hardware_flash pico_flash hardware_i2c
  pico_cyw43_arch_lwip_threadsafe_background
  pico_lwip_mbedtls pico_mbedtls pico_lwip_sntp)
# Review (final), Critical 1: RP2350's Arm stack guard is the msplim
# register (pico_runtime_init/runtime_init_stack_guard.c) -- one instruction
# per core at init, no MPU region consumed -- but PICO_USE_STACK_GUARDS
# defaults to 0, so nothing was watching either core's stack. Core 1's stack
# sits directly below the newlib heap that holds mbedTLS's ~16 KB record
# buffers; an overrun there corrupted them silently, with no fault and no
# symptom except wrong flux on the wire. With this on, an overrun is a hard
# fault at the instruction that caused it. Kept as a permanent regression
# trap, not a one-off: src/main.c's core1_stack is sized from a static
# analysis of the built ELF, and a static analysis can only bound the
# direct-call graph -- the indirect calls through mbedTLS's and lwIP's
# function pointers are exactly what it cannot see.
target_compile_definitions(wifi_floppy PRIVATE PICO_USE_STACK_GUARDS=1)

# Overridable so a build can identify ITSELF. The default has read "4b.0"
# through every firmware change in this project's history -- the display, the
# flux capture, the MFM decoder -- so as a default it distinguishes nothing.
# CI passes the git description; rollout, rollback and anti-rollback in the
# firmware-update design all need a version that moves when the image does.
# An experiment build that lets the Amiga write, so the capture path can be
# tested against a real drive. Writes are decoded and logged, NEVER applied --
# see main.c's comment, which spells out that the Amiga will believe a write
# succeeded and later read stale data back.
option(WF_WRITE_CAPTURE "Release WPROT so writes can be captured (writes are discarded)" OFF)
# Diagnostic: re-read and decode every track from PSRAM after a mount. See
# main.c. Off by default -- it costs one track's decode per service-loop
# iteration for 160 iterations after each mount.
option(WF_VERIFY_TRACKS "Verify every track out of PSRAM after a mount" OFF)
if (WF_VERIFY_TRACKS)
  target_compile_definitions(wifi_floppy PRIVATE WF_VERIFY_TRACKS=1)
  message(STATUS "WF_VERIFY_TRACKS is ON: every mount sweeps all 160 tracks.")
endif ()
# Diagnostic: a PIO logic analyser on the eight bus inputs, one log record per
# change. See bus_sniff in floppy.pio. Off by default.
option(WF_BUS_SNIFF "Log every change on the bus inputs, in exact order" OFF)
if (WF_BUS_SNIFF)
  target_compile_definitions(wifi_floppy PRIVATE WF_BUS_SNIFF=1 WF_LOG_SLOTS=512)
  message(STATUS "WF_BUS_SNIFF is ON: every bus input change is logged.")
endif ()
if (WF_WRITE_CAPTURE)
  target_compile_definitions(wifi_floppy PRIVATE WF_WRITE_CAPTURE=1)
  message(WARNING "WF_WRITE_CAPTURE is ON: this image lets the Amiga write, and throws the writes away.")
endif ()

# Write-back piece 1 (docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md
# §2): a whole, clean captured track is written into the board's copy of the disk, so the
# Amiga reads its own writes back. NOTHING is sent upstream yet -- writes are lost at eject.
# Capture is always compiled in; WF_WRITE_CAPTURE need not be set. Removed in piece 2,
# when writes reach the server.
option(WF_WRITE_BACK "Apply captured writes to the board's copy (lost at eject)" OFF)
if (WF_WRITE_BACK)
  target_compile_definitions(wifi_floppy PRIVATE WF_WRITE_BACK=1)
  message(WARNING "WF_WRITE_BACK is ON: writes change the board's copy of the disk and are LOST at eject.")
endif ()

set(FIRMWARE_VERSION "4b.0-dev" CACHE STRING
    "Version string the device reports at registration")

target_compile_definitions(wifi_floppy PRIVATE
  WEBADF_HOST=\"webadf.vercel.app\"
  # Task 7: WIFI_SSID, WIFI_PASS and WEBADF_PAIRING_CODE (plan 4a's
  # compile-time credentials) are gone -- core1_main now reads all three
  # from config_store.h (provisioning.c/portal_net.c), populated either by
  # a prior boot's flash write or by the captive portal at runtime. Neither
  # has a compile-time value any more, so there is nothing left for these
  # defines to do.
  FIRMWARE_VERSION=\"${FIRMWARE_VERSION}\")
if (NOT WFMF_OMIT_AUTHMODE)
  target_compile_definitions(wifi_floppy PRIVATE
    ALTCP_MBEDTLS_AUTHMODE=MBEDTLS_SSL_VERIFY_REQUIRED)
endif ()

# Spec D-4b-2: the provisioning AP is WPA2 with a single fixed,
# compile-time password rather than an open AP (which would hand the board
# to anyone in range who also knows/guesses a valid pairing code) or a
# per-board password derived from the MAC (considered and rejected there as
# more ceremony than the operator's own boards warrant). portal_net.c's
# portal_run() is the only consumer (cyw43_arch_enable_ap_mode()'s
# `password` argument).
#
# Review round 1 (recommendation, accepted): this used to be a hardcoded
# literal PSK here, which is a real WPA2 credential committed to git history
# the moment this file is -- the comment above already said that was wrong
# for a shipped build, so fix it now rather than after a history rewrite is
# the only remedy.
#
# It was NOT fixed in time: the literal reached git and stayed there, and
# the history was rewritten on 2026-09-13 before the repository was made
# public -- which is exactly the remedy this comment warned would be the
# only one left. The value itself is gone from every commit; this note
# stays because the lesson is the point. A credential in a source file is
# already leaked, and moving it to the environment afterwards does not
# unleak it.
#
# Sourced from the environment the
# same way WIFI_PASS/WEBADF_PAIRING_CODE are above, with a fatal-error
# guard: unlike those two (which degrade to an unusable-but-harmless
# empty compile-time string if unset), an empty WPA2 PSK is invalid
# outright, and cyw43_arch_enable_ap_mode() has no way to report that
# back at runtime on a board with no console -- refuse to build instead.
# DEFAULT "wififloppy", overridable from the environment (operator, 2026-09-13).
#
# This used to refuse to build without the variable set, on the reasoning that
# a compile-time PSK in a source file is a leaked credential. That reasoning is
# sound and it is also why a default is now the honest choice rather than a
# retreat: the password is compiled into every image, the repository is public,
# and firmware is meant to be distributed -- so it was never going to be a
# secret, and pretending otherwise only made the project harder to build.
#
# What actually gates provisioning is the PAIRING CODE. The AP password stops a
# passer-by idly joining the setup network during the seconds it is up; it was
# never the thing standing between a stranger and your WiFi credentials.
#
# A board that wants a private one sets PORTAL_AP_PASSWORD at build time. An
# explicitly EMPTY value is still refused: an empty WPA2 PSK is invalid
# outright, and cyw43_arch_enable_ap_mode() has no way to report that back at
# runtime on a board with no console.
set(PORTAL_AP_PASSWORD_DEFAULT "wififloppy")
if (DEFINED ENV{PORTAL_AP_PASSWORD})
  if ("$ENV{PORTAL_AP_PASSWORD}" STREQUAL "")
    message(FATAL_ERROR
      "PORTAL_AP_PASSWORD is set but empty. Leave it unset to take the default "
      "(\"${PORTAL_AP_PASSWORD_DEFAULT}\"), or set a WPA2 PSK of 8-63 characters.")
  endif ()
  set(PORTAL_AP_PASSWORD "$ENV{PORTAL_AP_PASSWORD}")
else ()
  set(PORTAL_AP_PASSWORD "${PORTAL_AP_PASSWORD_DEFAULT}")
  message(STATUS "PORTAL_AP_PASSWORD not set; using the default provisioning "
                 "AP password \"${PORTAL_AP_PASSWORD_DEFAULT}\".")
endif ()

target_compile_definitions(wifi_floppy PRIVATE
  PORTAL_AP_PASSWORD=\"${PORTAL_AP_PASSWORD}\")

# Why these fifteen -Wl,-u entries stay, now that every one of them has a
# real caller.
#
# The defect they were built against is plan 4a's Critical C1: the entire
# TLS stack was silently discarded by --gc-sections while the cross-build
# stayed green, because nothing referenced it -- the ELF contained zero
# mbedTLS/roots.h content and the "clean build" proved nothing about the
# artifact. Every 4b module hit the same class as it landed (config_store
# on day one: the object compiled clean and
# `arm-none-eabi-nm wifi_floppy.elf | grep config_store` found nothing at
# all, defined or undefined), because each was written a task or more
# before its caller existed. `-Wl,-u,<symbol>` forces the linker to resolve
# a symbol as if something referenced it, which keeps its section -- and
# the whole graph it references -- alive under --gc-sections. Sections here
# are per-function (-ffunction-sections, implied by the SDK's default build
# flags), so each public entry point needs its own entry; forcing
# config_store_load alone would not keep config_store_save/_erase.
#
# As of plan 4b task 10 that scaffolding is no longer load-bearing: main.c
# calls prov_*, config_store_*, portal_run() and portal_stop() directly,
# and portal_net.c calls dns_handle/dhcp_handle/portal_request, so every
# symbol below is reachable from main() and would survive --gc-sections on
# its own. They are kept anyway, deliberately, for two reasons: they cost
# nothing on a build that already links these symbols, and they are a
# tripwire for the reverse regression -- if a future refactor drops the
# last real caller of one of these entry points, the link keeps it in the
# ELF and the failure shows up as dead code to notice rather than as a
# green build over a silently gutted binary, which is exactly the shape
# 4a's Critical took. Deleting an entry here is only correct together with
# deleting the function it names.
#
# (tls_transport and sntp_sync_blocking predate 4b -- same story, same
# reasoning; see task-9-report.md for that pair's nm/strings evidence and
# task-1-report.md for config_store's.)
target_link_options(wifi_floppy PRIVATE
  -Wl,-u,tls_transport -Wl,-u,sntp_sync_blocking
  -Wl,-u,config_store_load -Wl,-u,config_store_save -Wl,-u,config_store_erase
  -Wl,-u,prov_init -Wl,-u,prov_on_assoc_result
  -Wl,-u,prov_on_verified_submit -Wl,-u,prov_on_pairing_code_rejected
  -Wl,-u,prov_on_portal_idle_timeout
  -Wl,-u,dns_handle -Wl,-u,dhcp_handle -Wl,-u,portal_request
  -Wl,-u,portal_run -Wl,-u,portal_stop)

# altcp_tls_mbedtls.c is the SDK's own file (patched for mbedtls 3.x
# compatibility -- see pico_lwip's CMakeLists.txt) when the bundled mbedtls
# is 3.x, or lwIP's upstream apps/altcp_tls/altcp_tls_mbedtls.c for 2.x.
# Either way it has calls whose return value this project's -Wall -Wextra
# would flag; it's the SDK's file, not this project's, to hold to that bar.
#
# It also reaches into mbedtls_ssl_context/mbedtls_ssl_session fields
# (out_left, session.start) that mbedtls 3.x wraps in MBEDTLS_PRIVATE(),
# renaming them to private_* unless MBEDTLS_ALLOW_PRIVATE_ACCESS is defined
# for that translation unit (mbedtls/private_access.h) -- without it, this
# exact pico-sdk 2.3.0 + bundled mbedtls 3.6.6 combination fails to compile
# at all ("has no member named 'out_left'"/"'start'"). This is the escape
# hatch mbedtls itself provides for legacy code like this SDK file that
# still needs direct struct access; scoped to just this one file so the
# rest of the tree keeps the private-access discipline.
if (MBEDTLS_VERSION_MAJOR AND MBEDTLS_VERSION_MAJOR GREATER_EQUAL 3)
  set(WFMF_ALTCP_TLS_MBEDTLS_SRC ${PICO_SDK_PATH}/src/rp2_common/pico_lwip/altcp_tls_mbedtls.c)
else ()
  set(WFMF_ALTCP_TLS_MBEDTLS_SRC ${PICO_LWIP_PATH}/src/apps/altcp_tls/altcp_tls_mbedtls.c)
endif ()
set_source_files_properties(
  ${WFMF_ALTCP_TLS_MBEDTLS_SRC}
  PROPERTIES
  COMPILE_OPTIONS "-Wno-unused-result"
  COMPILE_DEFINITIONS "MBEDTLS_ALLOW_PRIVATE_ACCESS")

# GP0/GP1 are this board's default UART pins and are used here for INDEX and
# CHNG - keep stdio off the UART or it will drive the floppy bus.
# Bounds what an unattended USB port costs core0's 1 ms service loop.
# The SDK default is 500 ms per write, which would be catastrophic there:
# wf_log_drain() is called from the same loop that services track changes.
target_compile_definitions(wifi_floppy PRIVATE PICO_STDIO_USB_STDOUT_TIMEOUT_US=1000)

# UART stays OFF. GP0 and GP1 are INDEX and CHNG on this board -- enabling
# UART stdio would drive the floppy bus. The log goes out over USB CDC only.
pico_enable_stdio_uart(wifi_floppy 0)
pico_enable_stdio_usb(wifi_floppy 1)

pico_add_extra_outputs(wifi_floppy)
