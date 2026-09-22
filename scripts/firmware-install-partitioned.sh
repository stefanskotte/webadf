#!/usr/bin/env bash
# One-time USB install of the partitioned firmware (spec D11). Saves a full
# flash backup first: it holds the Wi-Fi password and the device token, so it
# lives outside the repo, owner-only.
set -euo pipefail
FW="$(cd "$(dirname "$0")/.." && pwd)/wifi-floppy/firmware/build"
BK="$HOME/.webadf/board-backups"
mkdir -p "$BK"; chmod 700 "$BK"

wait_bootsel() { for _ in $(seq 1 40); do picotool info >/dev/null 2>&1 && return 0; sleep 0.5; done;
  echo "board did not reach BOOTSEL -- hold BOOTSEL and tap RESET, then re-run"; exit 1; }

picotool reboot -f -u >/dev/null 2>&1 || true
wait_bootsel
out="$BK/$(date +%Y-%m-%d-%H%M%S)-before-partitioned-install.bin"
picotool save -a "$out"; chmod 600 "$out"
echo "backup: $out ($(shasum -a 256 "$out" | cut -c1-16)...)"

picotool load "$FW/wifi_floppy_pt.uf2"
picotool reboot -u; wait_bootsel
picotool partition info
picotool load -p 0 "$FW/wifi_floppy.uf2"
picotool reboot
echo "installed into slot A; watch the serial log for 'trial: confirmed'"
