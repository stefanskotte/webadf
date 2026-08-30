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
  src/mfm.c
  src/transport_tls.c src/sntp_time.c
  ${WFMF_PSA_CRYPTO_RANDOM_SRC})
pico_generate_pio_header(wifi_floppy ${CMAKE_CURRENT_LIST_DIR}/src/floppy.pio)
target_include_directories(wifi_floppy PRIVATE src ${CMAKE_CURRENT_LIST_DIR})
target_link_libraries(wifi_floppy
  pico_stdlib pico_multicore hardware_pio hardware_dma hardware_irq
  hardware_psram hardware_sync hardware_flash pico_flash
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

target_compile_definitions(wifi_floppy PRIVATE
  WIFI_SSID=\"$ENV{WIFI_SSID}\" WIFI_PASS=\"$ENV{WIFI_PASS}\"
  WEBADF_HOST=\"webadf.vercel.app\"
  # Compile-time provisioning (spec §7); 4b (captive portal) replaces only
  # where these two come from, nothing about how they're used here.
  WEBADF_PAIRING_CODE=\"$ENV{WEBADF_PAIRING_CODE}\"
  FIRMWARE_VERSION=\"4a.0\")
if (NOT WFMF_OMIT_AUTHMODE)
  target_compile_definitions(wifi_floppy PRIVATE
    ALTCP_MBEDTLS_AUTHMODE=MBEDTLS_SSL_VERIFY_REQUIRED)
endif ()

# Review round 1 finding (Critical, C1, part 2): the "cross-build green"
# gate is only meaningful once something actually forces transport_tls.c's
# and sntp_time.c's entry points to stay linked -- otherwise a future
# regression (e.g. someone reverting the psa_crypto_random.c fix above)
# can hide behind --gc-sections exactly as this task's first build did,
# with the ELF silently containing zero mbedTLS/roots.h content. Task 10
# will make main.c call these for real; until then, `-Wl,-u,<symbol>`
# forces the linker to resolve them as if something referenced them,
# pulling in (and keeping alive under --gc-sections) tls_transport()'s
# whole referenced graph -- g_transport's function pointers
# (tls_connect/tls_write/tls_read/tls_close), and therefore mbedTLS/altcp
# -- and sntp_sync_blocking()'s (pico_lwip_sntp, and sntp_time_apply() via
# lwipopts.h's SNTP_SET_SYSTEM_TIME hook). See task-9-report.md's fix
# report for the nm/strings evidence this now actually links in.
#
# Task 1 review, Critical: config_store.c hit the exact same defect class
# the day it landed -- nothing in main.c calls config_store_load()/_save()/
# _erase() yet (task 7 wires that up), so --gc-sections silently dropped
# the whole translation unit; the object file compiled clean but
# `arm-none-eabi-nm wifi_floppy.elf | grep config_store` found nothing at
# all, defined or undefined. Sections here are per-function
# (-ffunction-sections, implied by the SDK's default build flags), so
# forcing just one entry point (e.g. only config_store_load) keeps that
# one function's section alive but NOT config_store_save()/_erase() --
# each public entry point needs its own `-Wl,-u,<symbol>` to survive
# --gc-sections until task 7 gives them a real caller. See
# task-1-report.md's fix report for the nm evidence this now actually
# links in all three, and for the before/after with the flags removed.
target_link_options(wifi_floppy PRIVATE
  -Wl,-u,tls_transport -Wl,-u,sntp_sync_blocking
  -Wl,-u,config_store_load -Wl,-u,config_store_save -Wl,-u,config_store_erase
  -Wl,-u,prov_init -Wl,-u,prov_on_assoc_result
  -Wl,-u,prov_on_verified_submit -Wl,-u,prov_on_pairing_code_rejected)

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
pico_enable_stdio_uart(wifi_floppy 0)
pico_enable_stdio_usb(wifi_floppy 1)

pico_add_extra_outputs(wifi_floppy)
