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
with no recursion). Transfer 2.6 adds 944 B of code (50,960 B) and 240 B of fixed buffers (BSS 25,428 B), no stack.

## Using it

- **From Workbench:** double-click it (from a Shell: `Transfer GUI`). The window, titled *WebFloppy - Receive & Send*,
  shows the folder (**Choose…** opens a requester; **Save** stores it), the status, and the queue: waiting, receiving
  NN %, done, or failed with the reason. Close the window to stop; files still waiting stay queued on the server.
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
- **Browsing from the web app (protocol 3, spec 2026-10-30 §2):** with **Let the web app browse my disks (read-only)**
  ticked, or `Transfer BROWSE`, the web app's Files can list the Amiga's volumes and drawers (NET:) and copy files from
  them. The board asks with `VOLS`, `DIR` and `GET`; Transfer answers only the board it trusts, reads with shared locks,
  and never writes. A drawer lists its first 1000 entries. A disk taken out mid-read fails the request, without a
  requester. The status line (or one Shell line per request) shows what the web app read: "Web: listed Work:Programs".
  The switch is the file `ENVARC:webadf/Browse` (`1`/`0`, copied to `ENV:`): the checkbox stores it at once;
  `BROWSE` switches it on for one run, `BROWSE SAVE` stores it too, and the window switches it off. Off is the default.
  A Shell user switches it off by unticking the box in the window, or with `Delete ENVARC:webadf/Browse
  ENV:webadf/Browse` and starting Transfer again without `BROWSE`. Unticking also stops a request already accepted and
  a GET's file not yet sent: the board hears `ERR <rid> off`.
  Changing it closes the board's connection when idle, so the board reconnects and learns it. Needs board firmware
  1.22 or newer.
- **Writing from the web app (protocol 4, spec 2026-10-31 §2):** with **Let the web app change my disks** also ticked
  (it is greyed while browsing is off), or `Transfer WRITE` (which switches browsing on too), the web app's Files can
  copy files onto any mounted volume (the boot volume included), and make drawers, rename and move within a volume,
  delete (a drawer with its contents), set protection bits and comments. The board sends `FILE` with an absolute path
  (`Work:Tools/x`) and `keep`, `replace` or `skip` for a name that exists (`replace` deletes the old file only after the
  new one's CRC matched; one that cannot be deleted stays, and the copy fails), and `MKDIR`, `RENAME`, `DELETE`,
  `PROTECT` and `NOTE`. Nothing is forced: a write-protected or full disk, a file protected from deletion or in use is
  reported with AmigaDOS's words, never with a requester on the Amiga. A drawer delete stops at the first refusal and
  says how many entries it removed. Each change is one Shell line or the status line: "Web: deleted Work:old (37)".
  The switch is the file `ENVARC:webadf/Write` (`1`/`0`, copied to `ENV:`), stored at once by the checkbox; `WRITE`
  is for one run, `WRITE SAVE` stores it (and browsing). Unticking browsing unticks writing. Off is the default.
  Changing it closes the board's connection when idle, so the board reconnects and learns it. Needs board firmware
  1.23 or newer.
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

While `Transfer` runs, it listens on TCP port 6800 for the board.

## Layout

| Path | What |
|---|---|
| `core/` | portable C: CRC-32, name rules, the protocol state machine (every decision lives here) |
| `posix/rx_posix.c` | a host build of the receiver, for tests and CI (stdin: SEND <path>, TRUST, CANCEL <tag>) |
| `amiga/` | dos.library and bsdsocket glue, the Shell form and the gadtools window |
| `fake-board.ts`, `scenarios.ts`, `run-scenarios.ts` | the board's side of the protocol, and the shared scenarios |
| `uae/uae-test.sh` | runs the scenarios against the real binary in FS-UAE |

## Testing and building

```bash
pnpm receive:test                                # host tests of the core
pnpm vitest run tools/receive/receive.int.test.ts  # the POSIX build against the fake board
pnpm receive:build /tmp/Transfer                 # Docker cross-build; fails unless it matches receive.sha256
pnpm receive:uae 204|31|32 [shell|gui|space|ram|send|browse|write]  # FS-UAE on Kickstart 2.04 / 3.1 (A1200) / 3.2 (A500)
```

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
  rebuild the driver disk (its pin changes too). `Install` copies it to `SYS:Tools/` and `C:`, and deletes an older
  `C:Receive` and `SYS:Tools/Receive` (+ `.info`) when present.
