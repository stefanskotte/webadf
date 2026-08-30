#!/usr/bin/env bash
# Fetches five pinned CA root certificates and emits src/roots.h as a PEM
# string literal (plus tools/roots.pem, the flat bundle used to verify it).
#
# Why these five: the live chain for webadf.vercel.app today is
#   *.vercel.app -> Google Trust Services WR1 -> GTS Root R1
# GTS Root R1 alone would cover today's chain. The other four (ISRG Root X1,
# DigiCert Global Root G2, Amazon Root CA 1, GlobalSign Root CA) are pinned
# alongside it so a future CDN/CA change upstream of Vercel doesn't stall
# every device in the field waiting on a firmware update -- they're the CAs
# most commonly seen fronting large hosting platforms.
#
# Review round 1 finding (Important, I5): an earlier version of this script
# fetched five live URLs with no expected fingerprint and only checked
# self-signature -- a check any attacker-supplied root also satisfies -- so
# a compromised download (bad DNS, a compromised CDN edge, a MITM'd `curl`)
# would have been *documented* (the fingerprint comment was written from
# whatever got downloaded) rather than rejected. The fix: the five SHA-256
# fingerprints below are the actual pin -- hand-verified once against each
# CA operator's own published fingerprint page/repository at the time this
# script was written -- and every fetch is checked against them before
# anything is written to roots.h/roots.pem. A mismatch is a hard failure,
# not a warning.
#
# This script still does not verify TLS-chain validity by itself. After
# running it (or after a fingerprint roll -- see below), verify the emitted
# bundle actually validates the live host (task-9-brief.md Step 1):
#   openssl s_client -connect webadf.vercel.app:443 -servername webadf.vercel.app \
#     -CAfile wifi-floppy/firmware/tools/roots.pem 2>&1 | grep "Verify return code"
# Expected: "Verify return code: 0 (ok)". If not, STOP -- do not commit a
# roots.h that fails this check.
#
# Rolling a pin: if a CA operator genuinely rotates one of these roots, this
# script will fail loudly with both the expected and actual fingerprint.
# Confirm the new fingerprint out-of-band (the operator's own site, a second
# network path, a second person) before updating PINNED_SHA256 below --
# never just paste in whatever the script downloaded.
set -euo pipefail
cd "$(dirname "$0")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() {  # fetch <url> <outfile>
    curl -fsSL "$1" -o "$2"
}

# Canonical, operator-published PEM (or DER, converted below) downloads.
fetch https://pki.goog/repo/certs/gtsr1.pem                "$WORK/gts_root_r1.pem"
fetch https://letsencrypt.org/certs/isrgrootx1.pem          "$WORK/isrg_root_x1.pem"
fetch https://cacerts.digicert.com/DigiCertGlobalRootG2.crt.pem "$WORK/digicert_global_root_g2.pem"
fetch https://www.amazontrust.com/repository/AmazonRootCA1.pem  "$WORK/amazon_root_ca1.pem"
fetch https://secure.globalsign.com/cacert/root-r1.crt      "$WORK/globalsign_root_ca.der"
openssl x509 -in "$WORK/globalsign_root_ca.der" -inform DER \
    -out "$WORK/globalsign_root_ca.pem" -outform PEM

# Parallel arrays (bash 3.2-compatible, so this runs under macOS's stock
# /bin/bash too): name, file, and the PINNED expected SHA-256 fingerprint
# (colons, uppercase, as openssl prints it). A trailing free-text note
# (empty string if none) is appended to that cert's line in roots.h --
# currently used only for GlobalSign Root CA's expiry.
NAMES=(
    "GTS Root R1"
    "ISRG Root X1"
    "DigiCert Global Root G2"
    "Amazon Root CA 1"
    "GlobalSign Root CA"
)
FILES=(
    "$WORK/gts_root_r1.pem"
    "$WORK/isrg_root_x1.pem"
    "$WORK/digicert_global_root_g2.pem"
    "$WORK/amazon_root_ca1.pem"
    "$WORK/globalsign_root_ca.pem"
)
PINNED_SHA256=(
    "D9:47:43:2A:BD:E7:B7:FA:90:FC:2E:6B:59:10:1B:12:80:E0:E1:C7:E4:E4:0F:A3:C6:88:7F:FF:57:A7:F4:CF"
    "96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6"
    "CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F"
    "8E:CD:E6:88:4F:3D:87:B1:12:5B:A3:1A:C3:FC:B1:3D:70:16:DE:7F:57:CC:90:4F:E1:CB:97:C6:AE:98:19:6E"
    "EB:D4:10:40:E4:BB:3E:C7:42:C9:E3:81:D3:1E:F2:A4:1A:48:B6:68:5C:96:E7:CE:F3:C1:DF:6C:D4:33:1C:99"
)
NOTES=(
    ""
    ""
    ""
    ""
    "expires 2028-01-28 -- rotate this pin (and re-run this script) before then"
)

: > roots.pem
for i in "${!NAMES[@]}"; do
    name="${NAMES[$i]}"
    file="${FILES[$i]}"
    expected="${PINNED_SHA256[$i]}"

    subject="$(openssl x509 -in "$file" -noout -subject -nameopt oneline)"
    issuer="$(openssl x509 -in "$file" -noout -issuer -nameopt oneline)"
    if [ "$subject" != "${issuer/issuer=/subject=}" ]; then
        echo "gen_roots.sh: $name ($file) is not self-signed (subject != issuer) -- refusing to pin a non-root cert" >&2
        exit 1
    fi

    actual="$(openssl x509 -in "$file" -noout -fingerprint -sha256 | cut -d= -f2)"
    if [ "$actual" != "$expected" ]; then
        echo "gen_roots.sh: $name ($file) SHA-256 fingerprint mismatch -- refusing to pin an unexpected certificate" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        echo "  If this CA genuinely rotated its root, verify the new fingerprint" >&2
        echo "  out-of-band before updating PINNED_SHA256 in this script -- see the" >&2
        echo "  'Rolling a pin' note at the top of gen_roots.sh." >&2
        exit 1
    fi

    cat "$file" >> roots.pem
done

# Emit roots.h: a PEM string literal (adjacent per-line string constants,
# each with an explicit \n -- mbedtls_x509_crt_parse() wants LF-terminated
# PEM lines) plus each cert's pinned SHA-256 fingerprint (the same value
# just checked above, not merely "whatever got downloaded") recorded in a
# comment so a future re-run's diff shows exactly what changed and why.
OUT=../src/roots.h
{
    echo "#ifndef ROOTS_H"
    echo "#define ROOTS_H"
    echo "// Generated by tools/gen_roots.sh -- do not hand-edit. Re-run that script to"
    echo "// refresh, then re-verify with the openssl check in task-9-brief.md Step 1"
    echo "// before committing: a bundle that cannot validate the live host is the"
    echo "// exact failure this file exists to prevent."
    echo "//"
    echo "// SHA-256 fingerprints (pinned in gen_roots.sh; every fetch is checked"
    echo "// against these before being written here -- a mismatched download fails"
    echo "// the script rather than being silently pinned):"
    for i in "${!NAMES[@]}"; do
        name="${NAMES[$i]}"
        fp="${PINNED_SHA256[$i]}"
        note="${NOTES[$i]}"
        if [ -n "$note" ]; then
            printf '// %-26s %s (%s)\n' "$name:" "$fp" "$note"
        else
            printf '// %-26s %s\n' "$name:" "$fp"
        fi
    done
    echo "#include <stddef.h>"
    echo
    echo "static const char root_ca_pem[] ="
    for file in "${FILES[@]}"; do
        sed -e 's/\r$//' -e 's/.*/"&\\n"/' "$file"
    done
    echo ";"
    echo
    echo "// mbedtls_x509_crt_parse() (PEM path) scans for the NUL terminator, so the"
    echo "// length it wants is sizeof(root_ca_pem) (includes the NUL), not strlen()."
    echo "static const size_t root_ca_pem_len = sizeof(root_ca_pem);"
    echo
    echo "#endif"
} > "$OUT"

echo "Wrote $(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT") and $(pwd)/roots.pem" >&2
