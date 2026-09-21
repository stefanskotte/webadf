# Firmware signing keys

Public keys only. The private half lives at `~/.webadf/firmware-signing-key` on the
operator's Mac, mode 0600, and is never committed, never uploaded, and never read by
server code (spec `docs/superpowers/specs/2026-09-22-firmware-release-registry-design.md`,
D3).

**Nothing verifies these signatures yet.** Increment 2 compiles the public key into the
firmware and checks a downloaded image against it before flashing. The keys are here, and
releases are signed, from the first release onward so that increment 2 adds a check rather
than re-signing a registry's worth of history.

What signing buys, precisely: TLS protects the wire and the device already verifies the
server's chain against pinned roots, but neither does anything about a compromised Vercel
account or a poisoned deploy pipeline. With the key offline, whoever owns the pipeline can
push a **stale** image and nothing worse — and anti-rollback closes that too.

Generate with `pnpm firmware:keygen`, once. Regenerating orphans every release signed with
the previous key, which is why the script refuses to overwrite an existing one.

| key id | generated | status |
|---|---|---|
| `wf-release-2026` | 2026-09-22 | current |
