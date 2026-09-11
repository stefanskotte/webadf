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
  cc -std=c11 -g -O1 -Wall -Wextra -Werror -DWFMF_HOST_TEST=1 \
     -o "$out" "$t" transport_fake.c \
     $(ls ../src/*.c | grep -vE 'main\.c|transport_tls\.c|sntp_time\.c|portal_net\.c|dskchg\.c|activity_led\.c|i2c_probe\.c') \
     || { echo "COMPILE FAIL: $t"; fail=1; continue; }
  "$out" || fail=1
done
exit $fail
