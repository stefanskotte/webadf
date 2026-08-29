# adfmfm

Encodes a standard 880 KB Amiga ADF into the `WFMF` container consumed by the
RP2350 floppy emulator in `wifi-floppy/`.

    encodeDisk(adf)   901,120 bytes  ->  2,027,536 bytes
    decodeDisk(blob)  2,027,536      ->  901,120

## The contract

The binary format is defined by `wifi-floppy/firmware/src/image_loader.c` and
described in `INTEGRATION.md`. `firmware-parser.ts` mirrors that parser's
acceptance rules; if `image_loader.c` changes, change it too.

`firmware-parser.ts` deliberately hardcodes its own copies of `IMAGE_MAGIC`,
`IMAGE_VERSION`, `NUM_TRACKS` and `TRACK_SLOT_BYTES` rather than importing them
from `constants.ts`. Do not "clean this up" by importing them. The whole point
of the duplication is that it is a drift detector: if the parser imported the
values it mirrors, a bad edit to `constants.ts` would silently still "match"
the mirror, because both sides would move together. Keeping the copies
independent means a firmware-affecting change to `constants.ts` has to be
re-derived and re-typed by hand into `firmware-parser.ts`, which is what
forces a human to notice when the two have drifted apart.

The design, and the derivation of every constant, is in
`docs/superpowers/specs/2026-08-29-adfmfm-encoder-design.md`.

## Three things that are easy to get wrong

1. The odd/even bit split is applied **per field**, not across a whole sector.
2. The sector header's fourth byte counts sectors to the gap by **physical
   position in the track**, not by sector id. They coincide for an image
   written in order, which is why an error here stays invisible.
3. The checksum runs over the **raw, pre-split** bytes, then folds with
   `(c ^ (c >>> 1)) & 0x55555555`.

## Validating a change

Round-trip tests are not sufficient — a symmetric misunderstanding of the bit
split or the checksum passes them cleanly. The real gate is a byte-diff against
Greaseweazle:

    pnpm adfmfm:diff          # all 61 disks in adf-archive/, needs pipx greaseweazle
    pnpm adfmfm:fixtures      # regenerate the committed golden fixtures

`pnpm vitest run` checks the committed fixtures, which come from synthetic
disks so that no disk image, or anything derived from one, enters the repo.

Note that `checksum` is zero for both an all-zero and an all-0xFF 512-byte
block, so the `zeros` and `ones` synthetic disks cannot catch a broken
checksum on their own. That is what `prng` and `bootblock` are for.

## The mutation matrix

The project's history is that five of twelve defects found across the first
two plans were tests that passed while testing nothing. Before trusting this
module's test suite, each of the following mutations was applied by hand, one
at a time, against a clean tree; `pnpm vitest run` was run; the failing tests
were recorded; the mutation was reverted. Full results, including the exact
failing test names observed, are in
`.superpowers/sdd/2026-08-29-adfmfm-encoder/task-8-report.md`.

Three rows are expected to leave specific tests green — those are not gaps
that slipped through, they are the documented reason the Greaseweazle
byte-diff (`pnpm adfmfm:diff`) exists as an external oracle rather than relying
on this suite alone.

| # | Mutation | File | Caught by |
|---|---|---|---|
| 1 | Header's 4th byte becomes `SECTORS - n - 1` | `track.ts` | the 16 `is byte-identical to Greaseweazle for ...` tests |
| 2 | `splitOddEven` emits even bits before odd | `mfm.ts` | `matches the reference for a mixed input` and the 16 byte-identity tests |
| 3 | Delete the `fillClockBits(out)` call | `track.ts` | all 16 byte-identity tests fail; `turns a run of zero bytes into 0xAA` stays green — it tests `fillClockBits` directly, not through `encodeTrack` |
| 4 | `checksum` drops the `^ (c >>> 1)` fold | `mfm.ts` | the three `matches the reference for ...` checksum tests, plus all 16 byte-identity tests |
| 5 | `fillClockBits` resets `y = x` each iteration | `mfm.ts` | `carries state across the byte boundary` |
| 6 | `TRACK_BITS = 100800` (shrinks the track) | `constants.ts` | the 16 byte-identity tests and `emits both gaps as 0xAA`. `returns exactly TRACK_BYTES` and `produces exactly WFMF_BYTES` stay green, because both sides of those assertions are derived from the same mutated constant — a constant-level error is only ever caught by the external oracle and by hardcoded expectations |
| 7 | `encodeDisk` passes `0` as every `trackNo` | `index.ts` | the four `every track of <kind> matches the golden fixture` tests. Every round-trip test stays green: a wrong-but-consistent track number round-trips through decode perfectly |
| 8 | `assertAdf` skips its length check | `adf.ts` | `rejects a short ADF`, `rejects an over-long ADF`, `rejects an empty ADF`, `does not pad a short ADF, unlike the reference` |

Row 6 also revealed an undocumented fourth blind spot: the golden-fixture
comparison in `index.test.ts` (`every track of <kind> matches the golden
fixture`) compares byte-by-byte only up to the length of the *shorter* array.
A shrunk `TRACK_BYTES` produces a track whose first N bytes are still correct,
so the comparison stops before it can see the missing tail and reports no
difference. Only the fixed-length tests in `track.test.ts` and the external
Greaseweazle diff catch a constant-level size regression reliably.

## Not here

No HTTP, no cache, no database — `GET /api/device/image/<sha256>` is separate.
No write-back, and no HD (22-sector) support.
