#!/usr/bin/env bash
# Host tests for Receive's portable core. Uses the firmware's harness.h (CHECK, RUN, REPORT).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
fail=0
CC="${CC:-cc}"
for t in test_*.c; do
  bin=".build/${t%.c}"
  "$CC" -std=c99 -O1 -g -Wall -Wextra -Werror -I../core -I../../../wifi-floppy/firmware/test \
    -o "$bin" "$t" ../core/rx_crc.c ../core/rx_names.c ../core/rx_proto.c
  "$bin" || fail=1
done
exit $fail
