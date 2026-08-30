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

add_executable(wifi_floppy
  src/main.c src/dskchg.c src/track_cache.c src/psram_image.c
  src/image_loader.c
  src/http_fetch.c src/mfm.c
  src/transport_tls.c src/sntp_time.c)
pico_generate_pio_header(wifi_floppy ${CMAKE_CURRENT_LIST_DIR}/src/floppy.pio)
target_include_directories(wifi_floppy PRIVATE src ${CMAKE_CURRENT_LIST_DIR})
target_link_libraries(wifi_floppy
  pico_stdlib pico_multicore hardware_pio hardware_dma hardware_irq
  hardware_psram hardware_sync
  pico_cyw43_arch_lwip_threadsafe_background
  pico_lwip_mbedtls pico_mbedtls pico_lwip_sntp)
target_compile_definitions(wifi_floppy PRIVATE
  WIFI_SSID=\"$ENV{WIFI_SSID}\" WIFI_PASS=\"$ENV{WIFI_PASS}\"
  TRACK_SERVER_IP=\"192.168.1.10\" TRACK_SERVER_PORT=8000
  WEBADF_HOST=\"webadf.vercel.app\")
if (NOT WFMF_OMIT_AUTHMODE)
  target_compile_definitions(wifi_floppy PRIVATE
    ALTCP_MBEDTLS_AUTHMODE=MBEDTLS_SSL_VERIFY_REQUIRED)
endif ()

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
