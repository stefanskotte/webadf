# System-configuration research

Status: SHIPPED as Create SysConf on 2026-11-04. The questions below are answered in `docs/superpowers/specs/2026-11-04-create-sysconf-design.md` and `HANDOFF.md` ("Create SysConf SHIPPED"), which supersede this note. Moved here from the HDPart project on 2026-11-04.

## The idea

A tool in WebFloppy that manages every setting in an Amiga's `Devs/system-configuration` and writes the file, because there is no convenient way to make one today. It fits here because WebFloppy already reads and edits files inside ADFs, so the file could be edited in place on a disk in the library.

Possibly useful, not yet checked for reuse:
- `docs/superpowers/specs/2026-09-01-adf-filesystem-reader-design.md`
- `docs/superpowers/specs/2026-09-04-adf-file-operations-design.md`

## Where it came from

HDPart's boot ADF had no `Devs/system-configuration`, and the Workbench screen and window titles showed topaz 9 instead of topaz 8. HDPart gets a small fixed file for that. It keeps its own copy of the generator and does not depend on this work.

## What's here

`mksysconfig.py` writes HDPart's fixed file from named fields: `python3 mksysconfig.py OUTPUT`. It is a starting point for the field layout, not the tool. It draws its own pointer, so it holds no Commodore data.

## The file format

`struct Preferences` from `intuition/preferences.h`: 232 bytes, big-endian. Byte 0 is `FontHeight`: 8 is `TOPAZ_EIGHTY`, 9 is `TOPAZ_SIXTY`. Kickstart reads the file from `devs:system-configuration` for the initial `SetPrefs()`.

## What is known

- Checked: the generator's output matches the `Devs/system-configuration` on the Workbench 3.2 disk byte for byte, apart from the pointer image. That proves the layout for the fields that file sets. Bytes that are zero in both prove nothing about those fields.
- Checked: the 3.1.4 and 3.2 Workbench disks ship a 232-byte file, and all 10 Kickstart ROMs tried, from 2.05 to 3.2.2, contain the name `system-configuration`.
- Tested since (WinUAE on 2.04-3.2, A500 on 3.1): adding the file changes the font on boot. As first written, not yet tested: HDPart's boot test will settle it; see the HDPart repo (`tools/mksysconfig.py`, `make adf`).

## Questions to settle first

1. Which fields take effect on which Kickstart? The header says that from V36 an increasing number of fields are ignored by `SetPrefs()`, and some are obeyed only at the initial one from this file. A form showing every setting would imply they all work, so the tool should show what really applies. Finding this out probably means testing in an emulator. HDPart's `tests/target/` shows how to drive WinUAE that way.
2. Is it true that nothing generates this file? The old Preferences program on Kickstart 1.x is believed to have written it, unverified. What writes it on 2.0 and later, where settings moved to `ENV:sys/*.prefs`, is unknown. This decides how big the gap is.
3. Where does it live in WebFloppy: on a disk's file view, as its own page, or both? Should a new file also be something you can add to any disk?
4. Should it read an existing file so people can edit what they have? The earlier suggestion was yes, with tests that real Workbench files load and save back byte for byte. Those test files would stay out of the repo unless their licensing is settled.

## Ideas so far, not decisions

- A core that reads and writes the 232 bytes with no UI in it, with the UI on top.
- Every setting as a named control, a pointer editor and colour pickers.
