# Transfer

The Amiga program that moves files between webadf and a folder you choose, through the board: it saves files sent
from the web app (receive) and sends files up to it (send); with browsing switched on, the web
app can also read your disks, and with writing switched on too, change them. Until 2.1 it was called Receive; the sources stay in
`tools/receive/`, and the settings files keep their names (`ReceiveDir`, `BoardKey`) so existing settings carry over. Spec:
`docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md` (protocol §2, the program §5).

It needs Kickstart 2.04 or newer, any 68000 or later, and a running TCP/IP stack (bsdsocket.library) on PaulaNET.

**Memory (2.4, measured on the A500 2026-10-31):** about 100 KB while it runs in a Shell: 43 KB of code, 24 KB of fixed
buffers, the 13 KB session and an 8 KB stack (the deepest Shell path measured 3,012 bytes: a "Please insert volume"
requester); the window adds its 68 KB list and a 32 KB stack. A 512 KB Amiga is not enough, and not because of Transfer:
with fast memory hidden (`NoFastMem`), `AddNetInterface` alone left 110 KB of chip memory, and once Transfer started the
TCP/IP stack had too little left to send a 1000-entry listing. Transfer waits out ENOBUFS (out of network buffers)
instead of dropping the connection. Transfer 2.5 adds 7.4 KB of code (50,016 B) and 1,396 B of fixed buffers (BSS
25,188 B) to 2.4's, measured from the hunks; the Shell stack stays 8 KB (a drawer delete keeps its place in one path,
with no recursion). Transfer 2.6 adds 956 B of code (50,972 B) and 320 B of fixed buffers (BSS 25,508 B), and no stack.
Transfer 2.7 (the commodity, the menu, the icon's tool types, the stopped copy) adds 3,240 B of code (54,212 B), 84 B
of data (396 B) and 96 B of BSS (25,604 B); the Shell form opens no new library. commodities.library is opened only
by the window (and icon.library only for a moment, to read the tool types).
Transfer 2.8 (a file sent again after a lost OK is not saved twice) adds 376 B of code (54,588 B) and 304 B of BSS
(25,908 B): the file saved last, remembered across connections.
Transfer 2.11 shows whole names in the window (up to 30 characters, narrower only on a screen with no room). Files waiting
to go onto a volume stay out of the window on purpose: listing them stalled a fresh Transfer's first file and slowed each
file on the A500 (bench 2026-11-02, about 4-6 s a file against 2-3 s).
The binary is 116 B larger (61956 B); no new buffers.
Transfer 2.12 fixes copies stopping while its window was the active one: the window no longer asks for Intuition's ticks. Holding a
list arrow no longer repeats; a click steps and the scroller drags.
Transfer 2.13 draws the window's list at most every 5 s (at once for what you did yourself): on every event it took a copy of
small files from 3.8 s to 6.7 s a file by 100 rows on the A500. The binary is 62,208 B.

## Using it

- **From Workbench:** double-click it (from a Shell: `Transfer GUI`). The window, titled *WebFloppy - Receive & Send*,
  shows the folder (**Choose…** opens a requester; **Save** stores it), the two web app switches on one row
  (**Web App: Read Write**), the status, and the queue: waiting, receiving NN %, done, or failed with the reason.
- **A commodity (Transfer 2.7):** the window is a commodity named *Transfer* in Exchange. Its close gadget only
  hides the window; Transfer keeps receiving, sending and answering the web app. The hotkey (default **Ctrl Alt W**)
  or Exchange's **Show** brings it back, Exchange's **Hide** hides it, **Project ▸ Quit** (Amiga-Q) or Exchange's
  **Kill** stops it (files still waiting stay queued on the server), and Ctrl-C to the process still does too.
  Exchange's **Disable** closes the board's connection and stops listening (a file mid-way fails as on any lost
  connection; the status says *Disabled in Exchange*); **Enable** listens again. A second start (a double-click, or
  `Transfer GUI`) only shows the running one's window; files given to that second start are not queued (drop them on
  the window instead); from a Shell it prints `Transfer is already running: its window is shown`. Without
  `commodities.library` (or without memory for the broker) the window works as before 2.7 (closing it stops Transfer)
  and, once it listens, the status line says `No Exchange: closing the window stops Transfer`.
  The Shell form (no `GUI`) is no commodity and opens no library it did not open before.
- **In WBStartup:** copy `SYS:Tools/Transfer` and `Transfer.info` to `SYS:WBStartup`. Its icon's tool types:
  `DONOTWAIT` (Workbench does not wait for it), `CX_POPUP=YES|NO` (`NO`: start with the window hidden),
  `CX_POPKEY=<hotkey>` (default `ctrl alt w`; on Kickstart 2.04 `ctrl` is spelled `control` for you), `CX_PRIORITY=<n>`
  (default 0), and `TO=<folder>` (the folder for this run, as the Shell's `TO`). The icon ships with `(CX_POPUP=NO)`,
  `(CX_PRIORITY=0)` and `(TO=SYS:Downloads)` as examples (in brackets: off). Read and Write have no tool type: the
  owner's consent stays in `ENVARC:webadf/Browse` and `ENVARC:webadf/Write`. `ctrl alt w` was checked against the
  hotkeys the Workbench 2.04, 3.1 and 3.2 disks set (`ctrl alt b/c/f/help`, `alt shift f10`).
- **The icon** (`dist/Transfer.info`, a classic 4-colour tool icon: a floppy, two arrows and a globe) is generated by
  `icon/make_transfer_icon.py` from `icon/transfer-icon.txt` (the two images as text), deterministically;
  `icon/check_transfer_icon.py` reads it back. Change the text, regenerate, commit both; the driver disk build fails
  if the committed icon is not what the source makes.
- **From a Shell:** `Transfer [RECEIVE] [TO <folder>] [SAVE] [GUI] [SEND <files>] [TRUST] [BROWSE] [WRITE]` (template
  `TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S,WRITE/S`)
  - `Transfer RECEIVE` receives; so does a plain `Transfer` (RECEIVE is the default), using the saved folder;
  - `Transfer SEND <files>` sends; `RECEIVE` and `SEND` together is refused with `Transfer: RECEIVE or SEND, not both`
    and return code 10;
  - `TO DH0:Downloads` uses that folder for this run, and `SAVE` also stores it;
  - `GUI` opens the window.

  It prints one line per file, and Ctrl-C stops it.
- **Sending to the web app (protocol 2, spec 2026-10-18):** drop icons on the window, press **Send…**, or type
  `Transfer SEND DH0:a.lha DH0:Drawer`. With a Transfer already running, the files are handed to it (port
  `webadf.Transfer`); otherwise that run listens itself and waits 60 s for the board. It prints a line per file and
  returns 0 (all sent), 5 (some) or 10 (none). A drawer sends its files with their paths under it (64 at most; `.info` files
  only when the icon itself is dropped). Files go only to the board whose key Transfer trusts: the first board it hears
  (saved in `ENVARC:webadf/BoardKey`); `TRUST` (or **Trust this board**) accepts another one.
- **Browsing from the web app (protocol 3, spec 2026-10-30 §2):** with **Web App: Read** ticked (2.6 and older:
  *Let the web app browse my disks (read-only)*), or `Transfer BROWSE`, the web app's Files can list the Amiga's volumes and drawers (NET:) and copy files from
  them. The board asks with `VOLS`, `DIR` and `GET`; Transfer answers only the board it trusts, reads with shared locks,
  and never writes. A drawer lists its first 1000 entries. A disk taken out mid-read fails the request, without a
  requester. The status line (or one Shell line per request) shows what the web app read: "Web: listed Work:Programs".
  The switch is the file `ENVARC:webadf/Browse` (`1`/`0`, copied to `ENV:`): the checkbox stores it at once;
  `BROWSE` switches it on for one run, `BROWSE SAVE` stores it too, and the window switches it off. Off is the default.
  A Shell user switches it off by unticking Read in the window, or with `Delete ENVARC:webadf/Browse
  ENV:webadf/Browse` and starting Transfer again without `BROWSE`. Unticking also stops a request already accepted and
  a GET's file not yet sent: the board hears `ERR <rid> off`.
  Changing it closes the board's connection when idle, so the board reconnects and learns it. Needs board firmware
  1.22 or newer.
- **Writing from the web app (protocol 4, spec 2026-10-31 §2):** with **Write** also ticked (2.6 and older: *Let the
  web app change my disks*; it is greyed while Read is off), or `Transfer WRITE` (which switches browsing on too), the web app's Files can
  copy files onto any mounted volume (the boot volume included), and make drawers, rename and move within a volume,
  delete (a drawer with its contents), set protection bits and comments. The board sends `FILE` with an absolute path
  (`Work:Tools/x`) and `keep`, `replace` or `skip` for a name that exists (`replace` deletes the old file only after the
  new one's CRC matched; one that cannot be deleted stays, and the copy fails), and `MKDIR`, `RENAME`, `DELETE`,
  `PROTECT` and `NOTE`. Nothing is forced: a write-protected or full disk, a file protected from deletion or in use is
  reported with AmigaDOS's words, never with a requester on the Amiga. A drawer delete stops at the first refusal and
  says how many entries it removed. Each change is one Shell line or the status line: "Web: deleted Work:old (37)".
  The switch is the file `ENVARC:webadf/Write` (`1`/`0`, copied to `ENV:`), stored at once by the checkbox; `WRITE`
  is for one run, `WRITE SAVE` stores it (and browsing). Unticking Read unticks Write. Off is the default.
  Changing it closes the board's connection when idle, so the board reconnects and learns it. Needs board firmware
  1.23 or newer.
  **Switching writing off stops a copy in progress (Transfer 2.7):** unticking Write (or Read) while a file is being
  copied onto a volume deletes its temporary `.webadf-rx` at once and writes nothing more; an existing file of that
  name (even with `replace`) is untouched. Transfer reads and drops the rest of the file's bytes and then answers
  `ERR <id> readonly writing is off in Transfer` -- after the last byte, because the board takes an answer only once
  it has sent the file (firmware `amiga_send.c`: `ERR` is read in `AS_FILE_SENT` and `AS_AWAIT_OK`, not in `AS_DATA`),
  so the connection stays usable. Ticking it again during those bytes does not resume the file. A file into the
  receive folder (a relative `FILE`) is not the web app's writing and is not affected.
- **Deletes take only what they mean (protocol 5, Transfer 2.6, spec 2026-10-31 §9):** a board with firmware 1.23.1
  says `WEBADF 5` and hears `READY 5 <b> <w>` (Transfer 2.5 answers it `READY 4`, and the board uses protocol 4).
  `DELETE <rid> <len>:<path> one` deletes exactly that object: a file, a link (never what it points to), or a drawer
  only when it is empty (`ERR <rid> notempty`, nothing inside touched); a Move uses it so only what was copied goes.
  A drawer DELETE without `one` first renames the drawer within its drawer to `.webadf-del-` and 8 hex digits, so a
  file saved into it by its old name while it is being emptied is not deleted with it; on a refusal it gets its name
  back (or, if that name was taken meanwhile, the error says where the rest is). If the rename fails it is deleted in
  place, as 2.5 did. On protocol 4 everything is as in 2.5. Two limits: a program that already holds the drawer (a
  Shell `CD`'d into it, an assign, an open Workbench window) still saves into it, and its file goes with it, as in 2.5;
  and if the Amiga resets or loses power mid-delete, what is left stays as `.webadf-del-…` in that drawer's parent.
- **The folder setting** is the file `ENVARC:webadf/ReceiveDir`, copied to `ENV:webadf/ReceiveDir`. The default is
  `RAM:`.
- **Nothing is overwritten:** a second `Foo.lha` arrives as `Foo_2.lha`. Nothing is written outside the folder,
  unless writing is switched on (above).
- **The same file twice is saved once (Transfer 2.8):** when the connection goes between a file's last byte and its
  `OK`, the board never hears the `OK` and sends the file again under the same id. Transfer remembers the file it
  saved last (id, size, CRC and the name it got): a repeat is answered `GO`, its bytes are read and dropped, and `OK`
  names the first copy -- no `Foo_2.lha`. Only while Transfer keeps running, and only while that copy is still there.

While `Transfer` runs, it listens on TCP port 6800 for the board.

## Layout

| Path | What |
|---|---|
| `core/` | portable C: CRC-32, name rules, the protocol state machine (every decision lives here) |
| `posix/rx_posix.c` | a host build of the receiver, for tests and CI (stdin: SEND <path>, TRUST, CANCEL <tag>) |
| `amiga/` | dos.library and bsdsocket glue, the Shell form and the gadtools window (`cx.c`: the commodity and tool types) |
| `icon/` | the icon's source (`transfer-icon.txt`), its generator and its reader |
| `fake-board.ts`, `scenarios.ts`, `run-scenarios.ts` | the board's side of the protocol, and the shared scenarios |
| `uae/uae-test.sh` | runs the scenarios against the real binary in FS-UAE |
| `uae/poke.c`, `uae/flip-scenario.ts` | FS-UAE only, never shipped: `poke` drives the Amiga from its own startup-sequence (input.device events, gadget clicks by ID, Exchange's own commands, the broker list), since keys typed on the Mac do not reach FS-UAE's Amiga |

## Testing and building

```bash
pnpm receive:test                                # host tests of the core
pnpm vitest run tools/receive/receive.int.test.ts  # the POSIX build against the fake board
pnpm receive:build /tmp/Transfer                 # Docker cross-build; fails unless it matches receive.sha256
pnpm receive:uae 204|31|32 [shell|gui|space|ram|send|browse|write|flip|icon|cx]  # FS-UAE on Kickstart 2.04 / 3.1 (A1200) / 3.2 (A500)
```

- **Transfer 2.7's modes** need Docker (they build `poke`) and save screenshots as `transfer-2.7-<ks>-<name>.png` in
  `WEBADF_SHOTS` (default: the run's folder): `flip` unticks Write while a 400 KB `replace` arrives (`rw`, `ro`);
  `icon` leaves the icon out on Workbench and double-clicks it, twice (`icon`, `icon-run`); `cx` starts it from
  `WBStartup` with `CX_POPUP=NO` and checks the hotkey, Exchange's Hide/Show/Disable/Enable/Kill, the close gadget, a
  second start and Project ▸ Quit (`hidden`, `exchange`). 3.1's and 3.2's Exchange come from their Extras disks
  (`WEBADF_EX31`, `WEBADF_EX32`), 3.2's ReAction classes from `Classes3.2.adf` (`WEBADF_CL32`).

- **The build** uses the amiga-gcc image pinned by digest in `build.sh`, and it is deterministic. After changing the
  sources, run `build.sh <out> --pin` and commit the new `receive.sha256`.
- **`uae-test.sh` expects:**
  - FS-UAE in `/Applications`;
  - the Kickstarts in `~/Documents/FS-UAE/Kickstarts/` (2.04: `amiga-os-204.rom`; 3.2:
    `kickCDTVa1000a500a2000a600.rom`) and `docs/kickstart3.1.rom` in the main checkout;
  - the Workbench disks in `~/Downloads/WB204/`, the main checkout's `adf-archive/` (3.1), and
    `~/Downloads/workbench-3.2-adf/` (`Workbench3.2.adf`, plus `ModulesA500_3.2.adf` for icon.library: the
    Workbench must match the Kickstart).

  `WEBADF_KS204`, `WEBADF_KS31`, `WEBADF_KS32`, `WEBADF_WB204`, `WEBADF_WB31`, `WEBADF_WB32`, `WEBADF_MOD32` and `WEBADF_FSUAE` override them. ROMs and
  Workbench disks are never committed.
- **FS-UAE's bsdsocket emulation** uses the Mac's network stack, so the Amiga's port 6800 is the Mac's port 6800.
  macOS may ask once whether FS-UAE may accept incoming connections.
- **The binary goes onto the PaulaNET driver disk** from `dist/Transfer`, the committed copy of the pinned build
  (CI checks they are identical). After changing the sources: `build.sh dist/Transfer --pin`, commit both, then
  rebuild the driver disk (its pin changes too). The disk's `Transfer.info` is `dist/Transfer.info` (since 2.7; it was
  PaulaNET Config's picture before). `Install` copies both to `SYS:Tools/`, Transfer to `C:`, and deletes an older
  `C:Receive` and `SYS:Tools/Receive` (+ `.info`) when present.
