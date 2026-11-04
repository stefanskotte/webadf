# Create SysConf

Date: 2026-11-04. Status: awaiting the operator's approval.

## Why

A bootable floppy with no `Devs/system-configuration` comes up in Topaz 9 with the wrong look, because the ROM's own
defaults have font height 9. HDPart hit this. No program on the 2.04, 3.1, 3.1.4 or 3.2 Workbench disks writes this
file or even names it, so people have no convenient way to make one. WebFloppy already writes files onto disks and
Amigas, so it can make one.

Who it is for: someone preparing a bootable floppy. Serial and printer settings are out (operator: nobody uses them on a
bootable floppy, and on a full Workbench install IPrefs replaces them later).

Starting research: `docs/superpowers/research/system-configuration/` (`README.md`, `mksysconfig.py`). This spec settles
its open questions where the ROM could.

## Goals

1. `Create SysConf…` replaces `Filter…` in the Files bank, and opens a dialog with every setting proven to be used.
2. Create writes a complete 232-byte `system-configuration` into the active pane.

## Non-goals

- Serial and printer settings (operator).
- Opening or editing an existing file (my call: the command is Create).
- Adding the file to a disk automatically, or making a `Devs` drawer. The person goes to the right place first.
- Saved presets, ready-made pointers, or importing a pointer image.
- Changing any firmware, Transfer or the driver disk.

## Anti-goals

- A control that does nothing. The operator's rule: show only what is proven to work.
- A value that can hurt the Amiga. `PointerTicks` is a divisor in Intuition (`divs.w $6c(a3)` in `SetPrefs`), so 0 must
  be impossible to write.
- Commodore data in the repo. The pointer comes from `mksysconfig.py`, which draws its own. Real Workbench files stay out
  of the repo.
- A file shorter than 232 bytes, under any path. It would be ignored at boot.

## What the ROMs say

Method: capstone over each ROM's `intuition.library`, every read through its stored Preferences pointer (`IntuitionBase`
+$902 on V36-37, +$816 from V39). 39 ROM images from 2.0 (36.143) to 3.2.1 (47.102) read the same set of fields. The 2.0
beta and 1.4 alpha differ and are out of scope. 3.2.2 and 3.2.3 ROMs were not checked. This proves the code reads a
field, not that the result is what a person sees: see Done means.

**The loader** (read on 2.04, 3.1, 3.2; in `dos.library`, and in `system-startup`'s area on 3.2): opens
`devs:system-configuration`, reads 232 bytes, and calls `SetPrefs` only if it got all 232. There is no checksum and no
version check. Bytes past 232 are never read. On 3.2 a short file gets the same `SetPrefs(buf, 0)` as no file; on 2.04
and 3.1 a short file gets no `SetPrefs` at all.

**One-shot fields:** Intuition's init clears flags `$50000` in `ib+$40` after applying its defaults, and the first real
`SetPrefs` sets them on V39 and later (on V37, `$10000` is set by `SetPrefs` and `$40000` by the first pointer change). So
font height, interlace and the pointer image are honoured once, at boot from this file. The gates and the setters were
read on 2.04, 3.1 and 3.2; the init clearing them was read on 3.1 only, which the boot test covers for the others.

| Offset | Field | Who reads it | When |
|---|---|---|---|
| 0 | FontHeight | Intuition | boot only |
| 185 bit 0 | LaceWB | Intuition | boot only |
| 28-99 | PointerMatrix | Intuition | boot only |
| 100, 101 | XOffset, YOffset | Intuition | boot only |
| 102-107 | color17-19 | Intuition | each SetPrefs |
| 110-117 | color0-3 | Intuition | each SetPrefs |
| 118, 119 | ViewXOffset, ViewYOffset | Intuition | each SetPrefs |
| 4, 12 | KeyRptSpeed, KeyRptDelay (timeval) | Intuition, to input.device | each SetPrefs |
| 20 | DoubleClick (timeval) | Intuition | each SetPrefs |
| 108 | PointerTicks | Intuition | each SetPrefs |
| 124 bit 15 | MOUSE_ACCEL | Intuition | each SetPrefs |
| 216, 217 | RowSizeChange, ColumnSizeChange | Intuition, to GfxBase NormalDisplayRows/Columns | each SetPrefs |

Hidden, and written as `mksysconfig.py` writes them: everything else. That includes the serial and printer fields, read
only by the disk-based `serial.device` and `printer.device`, and fields with no reader found (`ViewInitX`, `ViewInitY`
which `SetPrefs` overwrites, `SCREEN_DRAG`, `wb_Width`, `wb_Height`, `wb_Depth`, the padding).

IPrefs on a full Workbench also calls `GetPrefs` and `SetPrefs`, so saved prefs may replace these values after boot.
Which ones has not been observed.

## The button

- `Create SysConf…` replaces `Filter…` in `BANK_GRID` at the same place, new `BankCommand`, and joins the phone's More
  menu beside `Create ADF…`.
- `Filter…` only focuses the pane's filter field (`files-manager.tsx:1302`). The field and the `find` shortcut
  (`files-manager.tsx:1331`) stay, so nothing is lost.
- Writes to the active pane (operator), as Makedir and Create ADF do.
- Works wherever Makedir makes a real folder: STASH:, a writable disk, a writable NET: volume. Elsewhere it is
  aria-disabled with a reason, like every other command: not on LIBRARY: shelves, not in an archive, not on a read-only
  volume or NET:'s root. It uses the mounted-disk guard Makedir uses (`guarded([src?.disk], ...)`).

## The dialog

Mock-up approved by the operator, option A: `.superpowers/brainstorm/78363-1793788818/content/sysconf-dialog.html` (not
committed; this section stands alone). One scrolling `Modal`, four groups. Opens on the Workbench disks' values each
time.

| Group | Control | Starts at | Limits (my call unless noted) | Stored as |
|---|---|---|---|---|
| Display | System font: Topaz 8 (80 columns) / Topaz 9 (60) | Topaz 8 | those two | 8 / 9 |
| Display | Workbench screen: Interlace | off | | bit 0 |
| Display | Display position X, Y | 0, 0 | -16 to 16 | signed bytes |
| Display | Extra size: Rows, Columns | 0, 0 | -16 to 16 | signed bytes |
| Workbench colours | Four colours | AAA, 000, FFF, 68B | 12-bit | words 0RGB |
| Pointer | 16 x 16 editor, three colours plus clear, hot spot | the arrow in `mksysconfig.py`, 0, 0 | hot spot 0-15 | see below |
| Pointer | Three pointer colours | E44, 000, EEC | 12-bit | words 0RGB |
| Keyboard and mouse | Key repeat delay | 0.60 s | 0.02 to 2 s | timeval |
| Keyboard and mouse | Key repeat speed | 0.05 s | 0.02 to 1 s | timeval |
| Keyboard and mouse | Double-click time | 1.02 s | 0.02 to 10 s | timeval |
| Keyboard and mouse | Mouse speed: Fast / Medium / Slow | Fast | those three | 1 / 2 / 4 |
| Keyboard and mouse | Acceleration | off | | bit 15 of offset 124 |

**Pointer:** choose one of four inks (clear, three colours), click or drag cells, a separate tool sets the hot spot, and
Clear and Reset. Stored as `mksysconfig.py` does it: two control words, 16 rows of two bitplanes, two end words.

**Hot spot:** Intuition stores it as a negative offset and adds 1 to X when it reads it. Workbench's `XOffset -1, YOffset
0` means pixel (0, 0). So pixel (x, y) is stored as `XOffset = -x - 1`, `YOffset = -y`. Read from the code; the bench
confirms it.

**Words:** "read at boot only" beside Interlace, the font and the pointer. The dialog names the place it will write and
says the file must be in `Devs` on the disk you boot from; a sentence says a full Workbench's saved prefs may replace
these. Keep it short. The help topic in `src/lib/help/topics.tsx` changes with the behaviour.

**Invalid:** Create is unavailable with the reason beside the field while any value is out of range.

## Creating

- Always named `system-configuration`.
- A clash follows the usual setting and Replace / Keep both / Skip. The confirmation of a Replace is not weakened on
  NET:, where the file might be the Amiga's real one. Keep both makes a name no boot will read, and that is accepted.
- The browser sends the settings, and the server validates them and builds the bytes (my call), so a bad request cannot
  produce a bad file. The builder is one pure module (bytes out, no UI, no database) under `src/lib/files/`, written
  through the active place's `driver.write`, so NET: gets its usual job card and queue.
- Nothing on the board or the Amiga changes. A NET: write needs what any NET: write needs.

## Constraints

- Next.js here differs from training data: read `node_modules/next/dist/docs/` before writing route or page code.
- Self-hosting has full parity: no dependency on our deployment.
- No migration expected.
- Never commit ROMs or real Workbench files. Tests compare with a fixture made by `mksysconfig.py`, which holds no
  Commodore data.
- e2e: only the specs for touched areas, port 3100, serialised, in runs under 9 minutes.
- Web change: ask the operator about the self-host sync afterwards.

## Done means

- Unit tests:
  - the defaults build byte for byte what `mksysconfig.py` writes;
  - every control changes only its own bytes;
  - always 232 bytes;
  - mouse speed can only be 1, 2 or 4 and the server refuses anything else;
  - a pointer drawn and hot spot set come out in the expected words.
- e2e: the button replaces `Filter…`, the dialog creates the file in STASH: and inside a disk, a clash asks, the disabled
  reasons show, the filter field still works.
- Local, not committed: the defaults match the 3.2 Workbench disk's file byte for byte apart from the pointer image.
- **Boot test, before release:** in the emulator on Kickstart 2.04, 3.1, 3.1.4 and 3.2, boot a disk with no IPrefs in its
  startup and a made file that changes every setting, then see each take effect. On the A500, once, the same disk through
  the board. Settings that cannot be seen on a screen (key repeat, double-click, mouse speed, acceleration) are tried by
  hand on the A500, or reported as read from the code only. **Anything that does not take effect comes out of the dialog
  and is reported to the operator.** Also report what a Workbench with IPrefs and saved prefs replaces.
- `HANDOFF.md` updated; the research README's questions answered or pointed here.

## Left to the builder

Task breakdown, the route's shape, the drawing details of the editor (drag, keyboard access, touch on phones), the colour
control, how a value is typed versus stepped.
