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

Generate with `pnpm firmware:keygen`, once. It writes the public half into this directory
itself rather than printing it for you to copy: the private key now exists, so the
refuse-to-overwrite guard blocks every re-run, and a scrolled-away terminal used to leave
the public half unrecoverable through the tool. (`openssl pkey -in
~/.webadf/firmware-signing-key -pubout` recovers it by hand.) Regenerating orphans every
release signed with the previous key, which is why the guard exists.

**The key id is a fingerprint of the key itself** — `wf-` plus the first 16 hex of the
sha-256 of its SPKI DER — not a date. It was briefly `wf-release-<year>`, computed
independently at keygen and at publish time: the same expression evaluated at two moments,
which agree only within one calendar year. The first publish after New Year would have
recorded a `signingKeyId` naming a file that does not exist, and increment 2 resolves the
verifying key by exactly that id.

| key id | generated | status |
|---|---|---|
| `wf-1138f25902223da4` | 2026-09-22 | current |
