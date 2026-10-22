cmake_minimum_required(VERSION 3.13)
set(PICO_BOARD pico2_w)
include(pico_sdk_import.cmake)
project(lwbtest C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()
add_executable(lwbtest main.c)
# LWB+ on a plain Pico 2: the radio pins moved to header pins
target_compile_definitions(lwbtest PRIVATE
  CYW43_DEFAULT_PIN_WL_REG_ON=2
  CYW43_DEFAULT_PIN_WL_DATA_OUT=3
  CYW43_DEFAULT_PIN_WL_DATA_IN=3
  CYW43_DEFAULT_PIN_WL_HOST_WAKE=3
  CYW43_DEFAULT_PIN_WL_CS=4
  CYW43_DEFAULT_PIN_WL_CLOCK=5
  CYW43_PIO_CLOCK_DIV_INT=8)
target_include_directories(lwbtest PRIVATE ${CMAKE_CURRENT_LIST_DIR})
target_link_libraries(lwbtest pico_stdlib pico_cyw43_arch_none)
pico_enable_stdio_usb(lwbtest 1)
pico_enable_stdio_uart(lwbtest 0)
pico_add_extra_outputs(lwbtest)
