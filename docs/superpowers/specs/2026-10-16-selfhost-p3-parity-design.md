# Self-hosting P3: parity on a fresh install

**Date:** 2026-10-16 · **Status:** implemented; merged 9ea7c85 2026-10-16, first production runs verified (HANDOFF 3br)

## Where this sits

P1 (8ff594b) made the app run without Vercel; P2 (bdc84e7, web-1.0.0) packaged it as a compose stack on GHCR. Operator
rule: **self-hosting has full parity**. A fresh install today lacks four things our deployment has:

| Piece | Our deployment today | Fresh self-host today |
|---|---|---|
| Firmware releases | `pnpm firmware:publish` signs with the operator's key, stores `firmware/<version>.bin`, writes `firmware_releases`, makes GitHub release `fw-X.Y.Z` (signed `.bin`, `manifest.json`, `.uf2`s, notes in the body) | no releases; boards never offered updates |
| PaulaNET driver disk | ADF built by `tools/paulanet-disk/build.sh`, uploaded once by script, pinned by sha256 | `/api/paulanet-disk` and the net route answer 503 |
| TOSEC DATs | admin uploads DATs at `/admin/scan` | none; the nightly scan matches nothing |
| OpenRetro metadata | admin uploads FS-UAE Launcher's `Amiga.sqlite` | none |

Demozoo already works on a self-host (weekly public export via the scheduler).

## Facts this design rests on (measured 2026-10-16)

- A GitHub release carries everything a registry row needs except `security`: `manifest.json` has `version, semver,
  sequence, file, sha256, signature, signingKeyId, signatureFormat`; `wifi_floppy.bin` is byte-identical to the
  registry blob. The signature covers the sequence, so an import must keep the manifest's sequence. Boards verify
  with the public key compiled in (`wifi-floppy/firmware/src/fw_pubkey.h`, id `wf-1138f25902223da4`). TEST builds are
  never published to GitHub.
- OpenRetro's `Amiga.sqlite` exists only as FS-UAE Launcher's local sync of an API OpenRetro calls unpublished
  (spec 2026-08-31-openretro-enrichment-design.md §0.3, §6). No public download exists.
- TOSEC (spike): `https://www.tosecdev.org/downloads` lists releases as `/downloads/category/<n>-YYYY-MM-DD` (newest
  `59-2025-03-13`); each release page has one "TOSEC - DAT Pack - Complete" download link
  (`?download=<id>:tosec-dat-pack-complete-...`). The pack is a 96 MB stored (uncompressed) zip of 11,193 files,
  5.4 s to download here. It holds exactly 7 `TOSEC/Commodore Amiga - * - [ADF] (TOSEC-v*_CM).dat` files (21 MB):
  Games, Games Public Domain, Demos Various, Applications, Applications Public Domain, Coverdisks, Educational --
  **the same 7 sets and version dates production has imported.** Releases are months apart (2023-01, 2023-07,
  2024-05, 2025-03). No licence file in the pack.
- The PaulaNET ADF is built deterministically from `third-party/paulanet/` (in the public repo) plus our files by
  `build.sh` (needs `xdftool`, amitools); its sha256 is pinned in `src/lib/paulanet-disk.ts`. Rob Smith's files are
  redistributed by his permission (`THIRD-PARTY-NOTICES.md`); the operator confirmed 2026-10-16 that this covers
  bundling the built disk in the image.

## Decisions

| | Decision |
|---|---|
| D1 | **Firmware import cron** `GET /api/cron/firmware-import` (CRON_SECRET, like the others), daily, in `vercel.ts` so both our deployment and the self-host scheduler run it. Lists releases of `WEBADF_FIRMWARE_REPO` (default `stefanskotte/webadf`) via the public GitHub REST API without a token; considers tags `fw-<semver>` only. |
| D2 | **An import is accepted only if** the release has `manifest.json` and the manifest's `file` asset; the `.bin`'s sha256 equals the manifest's; `signatureFormat` is 2; `signingKeyId` is a key the server knows (the boards' public key, shared as a constant with the firmware header); and the ed25519 signature verifies over exactly what `firmware:publish` signs. Any failure: log `firmware import: <tag>: <reason>`, skip, write nothing. A version already in `firmware_releases` is skipped (idempotent; our deployment always finds its releases present). |
| D3 | **What is written:** the `.bin` to `firmwareStore` at `firmware/<version>.bin`, then the row with the manifest's `version, semver, sequence, sha256, signature, signingKeyId, signatureFormat`, `sizeBytes` = the `.bin` length, `notes` and `security` from the manifest when present, else notes = the release body text and `security = false`; `publishedByUserId` = the first super-admin (SUPERADMIN_EMAILS) that exists, and if none exists yet the import waits for the next run. Releases are imported oldest first. |
| D4 | **`firmware:publish` adds `notes` and `security` to `manifest.json`** (outside the signed fields), so future imports are exact. |
| D5 | **PaulaNET disk bundled:** the Docker build runs `tools/paulanet-disk/build.sh` in a dedicated stage (amitools installed there only) and **fails unless the ADF's sha256 equals the pinned one**; the final image carries `/app/assets/paulanet.adf`. On `start`, the ctl stores it in the disk store under its sha256 when missing (idempotent). Our deployment is unchanged (its blob exists). Image labels and docs point to `THIRD-PARTY-NOTICES.md`. |
| D6 | **TOSEC fetch cron** `GET /api/cron/tosec-fetch`, monthly, in `vercel.ts` (both deployments). Reads `https://www.tosecdev.org/downloads`, takes the category with the newest date; if newer than the release recorded in a state row, reads that release page, takes the "DAT Pack - Complete" download link, streams the zip to a temp file, extracts only entries matching `^TOSEC/Commodore Amiga - .* - \[ADF\] \(TOSEC-v.*\)\.dat$`, imports each with the existing `importDat`, then records the release. Partial failure records nothing as done (the next run retries). |
| D7 | **Loud failure:** if the downloads page has no dated category, the release page no Complete-pack link, or the pack no Amiga ADF DAT, the cron records `TOSEC fetch failed: <reason>` (with time) in the state row; `/admin/scan` shows the last fetch result (release imported, or the failure). The manual DAT upload stays. |
| D8 | **OpenRetro stays an admin upload**, documented: `/admin/scan` and `docs/self-hosting.md` say to run FS-UAE Launcher once and upload its `Amiga.sqlite`, naming where the Launcher keeps it on Windows, macOS and Linux. Covers already fetch on their own. |
| D9 | **Our host is never named for someone else's install:** the Demozoo and OpenRetro User-Agents use the install's own URL (`BETTER_AUTH_URL`, else the hosted label). |
| D10 | **Docs:** `docs/self-hosting.md` replaces "what self-hosting lacks" with what each piece does now (firmware imported daily, PaulaNET included, TOSEC fetched monthly, Demozoo weekly, OpenRetro by upload). |

## Testing

- **Firmware import (unit):** against fixture releases (a manifest + `.bin` signed with a test key, the verifier
  injected with that key): accepted; bad sha; bad signature; unknown key id; signatureFormat 1; missing `.bin` asset;
  non-`fw-` tags ignored; notes/security from manifest vs. from the body. **db test:** importing twice writes one row;
  the sequence is the manifest's; no super-admin -> nothing written.
- **The real signature (unit):** the verifier accepts the real `fw-1.13.0` manifest + `.bin` (checked-in manifest,
  `.bin` fetched in the test only if present locally; else the test verifies a stored known-good signature/sha pair).
- **TOSEC (unit):** the page parsers against saved copies of today's downloads page and release page; the extractor
  against a small built zip with Amiga ADF DATs, other Amiga DATs and other systems; **db test:** import + state row;
  a failed fetch leaves the previous release recorded and writes the failure.
- **PaulaNET:** the image build checks the sha; docker-smoke asserts `/api/paulanet-disk` answers 200 with the pinned
  sha.
- **Real runs on the Mac stack:** a real firmware import from GitHub (releases present on boards' key) and a real TOSEC
  fetch; both leave the expected rows. Our deployment: the firmware cron's first run imports nothing; the TOSEC cron's
  first run records 2025-03-13 (already-imported DATs re-import idempotently).

## Not in scope

Signing firmware on a self-host (boards accept only the operator's key -- by design); fetching OpenRetro metadata;
changing TOSEC/OpenRetro/Demozoo matching; the demo account mentioned in README.
