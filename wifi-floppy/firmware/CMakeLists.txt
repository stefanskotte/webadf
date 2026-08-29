cmake_minimum_required(VERSION 3.13)
include(pico_sdk_import.cmake)
project(wifi_floppy C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(PICO_BOARD pimoroni_pico_plus2_w_rp2350)   # RP2350B + RM2(CYW43) + 8MB PSRAM
# Board header supplies PICO_PSRAM_CS_PIN=47 and PICO_PSRAM_SIZE_BYTES=8MB,
# so the SDK runtime brings PSRAM up before main().
pico_sdk_init()

add_executable(wifi_floppy
  src/main.c src/dskchg.c src/track_cache.c src/psram_image.c
  src/image_loader.c
  src/http_fetch.c src/mfm.c)
pico_generate_pio_header(wifi_floppy ${CMAKE_CURRENT_LIST_DIR}/src/floppy.pio)
target_include_directories(wifi_floppy PRIVATE src ${CMAKE_CURRENT_LIST_DIR})
target_link_libraries(wifi_floppy
  pico_stdlib pico_multicore hardware_pio hardware_dma hardware_irq
  hardware_psram
  pico_cyw43_arch_lwip_threadsafe_background)
target_compile_definitions(wifi_floppy PRIVATE
  WIFI_SSID=\"$ENV{WIFI_SSID}\" WIFI_PASS=\"$ENV{WIFI_PASS}\"
  TRACK_SERVER_IP=\"192.168.1.10\" TRACK_SERVER_PORT=8000)
# GP0/GP1 are this board's default UART pins and are used here for INDEX and
# CHNG - keep stdio off the UART or it will drive the floppy bus.
pico_enable_stdio_uart(wifi_floppy 0)
pico_enable_stdio_usb(wifi_floppy 1)

pico_add_extra_outputs(wifi_floppy)
