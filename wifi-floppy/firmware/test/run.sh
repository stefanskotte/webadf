#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
fail=0
# Device-only files are excluded by name:
#   main.c            - entry point, defines its own main()
#   transport_tls.c    } not yet present / device-only network stack;
#   sntp_time.c        } listed so the exclusion still applies once added
#   http_fetch.c      - device network stack (lwIP), pulled in by nothing
#                       the host tests exercise
#   dskchg.c          - pulls in pico/stdlib.h (gpio_put, absolute_time_t);
#                       genuinely device-only, no host-portable logic to test
# image_loader.c used to be excluded here too: it called http_get_stream(),
# which only exists in the excluded http_fetch.c, so including it would fail
# to link. Task 3 removed that dependency (image_load() and its
# http_fetch.h include are gone; image_parse_buffer() is the host-testable
# replacement), so it now compiles into the host build like everything else.
for t in test_*.c; do
  out=".build/${t%.c}"
  cc -std=c11 -g -O1 -Wall -Wextra -Werror -DWFMF_HOST_TEST=1 \
     -o "$out" "$t" $(ls ../src/*.c | grep -vE 'main\.c|transport_tls\.c|sntp_time\.c|http_fetch\.c|dskchg\.c') \
     || { echo "COMPILE FAIL: $t"; fail=1; continue; }
  "$out" || fail=1
done
exit $fail
