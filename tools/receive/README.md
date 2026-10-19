# Receive

The Amiga program that saves files sent from webadf, through the board, into a folder you choose. Spec:
`docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md` (protocol §2, the program §5).

It needs Kickstart 2.04 or newer, any 68000 or later, and a running TCP/IP stack (bsdsocket.library) on PaulaNET.

## Using it

- **From Workbench:** double-click it. The window shows the folder (**Choose…** opens a requester; **Save** stores
  it), the status, and the receiving queue: waiting, receiving NN %, done, or failed with the reason. Close the window
  to stop; files still waiting stay queued on the server.
- **From a Shell:** `Receive [TO <folder>] [SAVE] [GUI] [SEND <files>] [TRUST]`
  - with no arguments, it uses the saved folder;
  - `TO DH0:Downloads` uses that folder for this run, and `SAVE` also stores it;
  - `GUI` opens the window.

  It prints one line per file, and Ctrl-C stops it.
- **Sending to the web app (protocol 2, spec 2026-10-18):** drop icons on the window, press **Send…**, or type
  `Receive SEND DH0:a.lha DH0:Drawer`. With a Receive already running, the files are handed to it (port
  `webadf.Receive`); otherwise that run listens itself and waits 60 s for the board. It prints a line per file and
  returns 0 (all sent), 5 (some) or 10 (none). A drawer sends its files with their paths under it (64 at most; `.info` files
  only when the icon itself is dropped). Files go only to the board whose key Receive trusts: the first board it hears
  (saved in `ENVARC:webadf/BoardKey`); `TRUST` (or **Trust this board**) accepts another one.
- **The folder setting** is the file `ENVARC:webadf/ReceiveDir`, copied to `ENV:webadf/ReceiveDir`. The default is
  `RAM:`.
- **Nothing is overwritten:** a second `Foo.lha` arrives as `Foo_2.lha`. Nothing is written outside the folder.

While `Receive` runs, it listens on TCP port 6800 for the board.

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
pnpm receive:build /tmp/Receive                  # Docker cross-build; fails unless it matches receive.sha256
pnpm receive:uae 204|31|32 [shell|gui|space|ram|send]  # FS-UAE on Kickstart 2.04 / 3.1 (A1200) / 3.2 (A500)
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
- **The binary goes onto the PaulaNET driver disk** from `dist/Receive`, the committed copy of the pinned build
  (CI checks they are identical). After changing the sources: `build.sh dist/Receive --pin`, commit both, then
  rebuild the driver disk (its pin changes too). `Install` copies it to `SYS:Tools/` and `C:`.
