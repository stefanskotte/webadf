#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
fail=0
# Device-only files are excluded by name:
#   main.c            - entry point, defines its own main()
#   transport_tls.c    } device-only network stack (lwIP/mbedTLS/cyw43);
#   sntp_time.c        } no host-portable logic to test
#   portal_net.c      - device-only network stack (lwIP raw UDP/TCP,
#                       cyw43_arch AP mode); no host-portable logic of its
#                       own -- everything it calls (dhcp_handle/dns_handle/
#                       portal_request) is already covered by its own
#                       host-tested source file
#   dskchg.c          - pulls in pico/stdlib.h (gpio_put, absolute_time_t);
#                       genuinely device-only, no host-portable logic to test
#   activity_led.c    } bring-up aids on hand-wired pins: a GPIO write plus an
#   i2c_probe.c       } alarm, and an SDK i2c_read_timeout_us scan. Both are
#                       device-only by construction and hold no logic a host
#                       test could judge -- what they assert is about wiring,
#                       which only a board can answer.
#   flux_capture.c    - the PIO state machine and DMA ring that carry WDATA off
#                       the bus. Only a floppy bus can exercise those. Every
#                       DECISION the capture makes lives in flux_bits.c and
#                       mfm.c instead, which are pure and ARE tested -- the
#                       split is deliberate, so that "we could not test it"
#                       covers register writes and nothing else.
# image_loader.c used to be excluded here too: it called http_get_stream(),
# which only existed in http_fetch.c/.h (device-only, lwIP-backed), so
# including it would fail to link. Task 3 removed that dependency
# (image_load() and its http_fetch.h include are gone; the incremental
# image_parse_begin/feed/end parser is the host-testable replacement), so it
# now compiles into the host build like everything else. http_fetch.c/.h
# themselves were deleted in task 10, once device_client.c/main.c gave the
# real device-side network path (TLS + the §10 poll loop) a replacement for
# what they used to do.
#
# transport_fake.c (this directory) is test infrastructure -- a scriptable
# transport_t used by task 6+'s protocol-state-machine tests -- so it is
# compiled into every test binary alongside src/*.c, not excluded from it.
for t in test_*.c; do
  out=".build/${t%.c}"
  # -D_DEFAULT_SOURCE: strnlen (config_store.c) is POSIX.1-2008, not C11, and
  # glibc declares it only when a feature-test macro asks. macOS declares it
  # anyway, so this build passed there for months and failed the first time it
  # ran on Linux in CI. The device build is unaffected -- newlib declares it --
  # which is exactly why nothing caught it until a second toolchain did.
  cc -std=c11 -D_DEFAULT_SOURCE -g -O1 -Wall -Wextra -Werror -DWFMF_HOST_TEST=1 \
     -o "$out" "$t" transport_fake.c \
     $(ls ../src/*.c | grep -vE 'main\.c|transport_tls\.c|sntp_time\.c|portal_net\.c|dskchg\.c|activity_led\.c|i2c_probe\.c|ssd1306\.c|flux_capture\.c') \
     || { echo "COMPILE FAIL: $t"; fail=1; continue; }
  if ! "$out"; then
    rc=$?
    # 128+n means a signal: a segfault or an abort, not an assertion. Say so --
    # the difference between "a test failed" and "a test crashed" is the
    # difference between reading the report and reaching for a debugger.
    if [ "$rc" -gt 128 ]; then
      echo "CRASHED (signal $((rc - 128))): $t -- see the last test name printed above"
    fi
    fail=1
  fi
done
exit $fail
