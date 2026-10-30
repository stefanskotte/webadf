# Transfer

The Amiga program that moves files between webadf and a folder you choose, through the board: it saves files sent
from the web app (receive) and sends files up to it (send); with browsing switched on, the web
app can also read your disks (read-only). Until 2.1 it was called Receive; the sources stay in
`tools/receive/`, and the settings files keep their names (`ReceiveDir`, `BoardKey`) so existing settings carry over. Spec:
`docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md` (protocol §2, the program §5).

It needs Kickstart 2.04 or newer, any 68000 or later, and a running TCP/IP stack (bsdsocket.library) on PaulaNET.

## Using it

- **From Workbench:** double-click it (from a Shell: `Transfer GUI`). The window, titled *WebFloppy - Receive & Send*,
  shows the folder (**Choose…** opens a requester; **Save** stores it), the status, and the queue: waiting, receiving
  NN %, done, or failed with the reason. Close the window to stop; files still waiting stay queued on the server.
- **From a Shell:** `Transfer [RECEIVE] [TO <folder>] [SAVE] [GUI] [SEND <files>] [TRUST] [BROWSE]` (template
  `TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S,RECEIVE/S,BROWSE/S`)
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
- **The folder setting** is the file `ENVARC:webadf/ReceiveDir`, copied to `ENV:webadf/ReceiveDir`. The default is
  `RAM:`.
- **Nothing is overwritten:** a second `Foo.lha` arrives as `Foo_2.lha`. Nothing is written outside the folder.

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
pnpm receive:uae 204|31|32 [shell|gui|space|ram|send|browse]  # FS-UAE on Kickstart 2.04 / 3.1 (A1200) / 3.2 (A500)
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
