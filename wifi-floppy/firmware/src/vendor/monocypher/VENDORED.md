# Vendored: Monocypher 4.0.2

- Version: 4.0.2
- Sources checked against each other before vendoring, and found identical:
  - https://monocypher.org/download/monocypher-4.0.2.tar.gz
  - https://github.com/LoupVaillant/Monocypher/archive/refs/tags/4.0.2.tar.gz
- Tarball SHA-256 (monocypher-4.0.2.tar.gz, as printed by `shasum -a 256`):
  `38d07179738c0c90677dba3ceb7a7b8496bcfea758ba1a53e803fed30ae0879c`
- Date vendored: 2026-09-23
- `diff -r` between `monocypher-4.0.2/src` (the monocypher.org tarball) and
  `Monocypher-4.0.2/src` (the GitHub tag archive) reported no differences.

Files copied verbatim, no modifications:
- `src/monocypher.c`, `src/monocypher.h`
- `src/optional/monocypher-ed25519.c`, `src/optional/monocypher-ed25519.h`
  (renamed here to `monocypher-ed25519.c/.h`, same content)
- `LICENCE.md`

Unmodified; only `crypto_ed25519_check` (RFC 8032, SHA-512) is used.
