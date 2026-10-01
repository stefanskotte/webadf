# Copy-protection analysis tools

Written 2026-10-01 to settle whether Gods' Rob Northen Copylock works from an ADF (HANDOFF §4, the
"Copy-protected originals" backlog entry). They are bench tools, not part of the app.

- `scan_protect.py [--detail] <dirs|adfs|zips>` -- one line per image: protection fingerprints in the
  decoded sectors (the Copylock prologue `pea / move.l (sp)+,$10 / illegal`), all-zero tracks, crack-group
  text, TOSEC flags. It only sees code stored uncompressed: "nothing found" is not "proven clean".
- `cl_run.py` (+ `amiga_hw.py`, `cl_emu.py`) -- runs Gods' Copylock on a 68000 core (Musashi via the
  `machine68k` package; Unicorn gets the flags wrong) with the trace exception modelled, logging disk-register
  access. `--watch` dumps registers; `--track-override` feeds a synthetic track 1. Gods-specific paths and
  addresses are hard-coded.
- `godsunpack.py`, `m68dis.py` -- helpers: Gods' file unpacker, a capstone wrapper.

Setup: a venv with `capstone` and `machine68k`. The emulator reads the Kickstart ROM from
`docs/kickstart3.1.rom` (gitignored, never committed). Never commit traces, memory dumps or decrypted
listings: they are derived from copyrighted code.
