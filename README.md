# webadf

An Amiga disk library that puts a disk in a real Amiga's floppy drive over WiFi.

Two halves that work together:

- **A web app** for keeping Amiga disk images. Upload them, have them identified
  against TOSEC, OpenRetro and Demozoo, organise them into collections, browse and
  edit the files inside a disk, and rewind a disk to any earlier version.
- **A drive replacement.** An RP2350 board plugs into the Amiga's floppy connector,
  behaves like a DD or HD floppy drive, and plays whichever disk you pick in the web app.
  When the Amiga saves, the changes go back to the library.

Pick a disk in the browser, or tap its NFC tag on the drive, and the Amiga reads it.
Workbench 3.1 boots from the board, games load, and saves made on the Amiga show up
in the web app as new versions of the disk.

![The rev B board: floppy header J1 on the left, buzzer and OLED in the middle, the Pico Plus 2 W module on the right](docs/screenshots/board-rev-b.png)

*Rev B, designed by Shanshe: 34-pin floppy header, floppy power connector, OLED
display, buzzer, a 4-pin header (J4), and a Pimoroni Pico Plus 2 W.
The KiCad project is in `wifi-floppy/hardware/`; check it with `pnpm hw:verify` before
ordering. The current bench board is rev A2.*

## Quickstart

A first install is one file. You need the board, a USB cable, a phone and an account in the
web app.

1. Hold the **BOOT** button (the Raspberry Pi docs call it BOOTSEL) and plug the board into
   your computer over USB. A drive called `RP2350` appears.
2. Download `wifi-floppy-install-<version>.uf2` from the
   [latest release](https://github.com/stefanskotte/webadf/releases/latest) and drag it onto
   that drive. The board writes it and restarts by itself; the drive disappears.
3. In the web app, open **Devices** and press **Pair a device** to get a code (it lasts 10
   minutes). On your phone, join the board's setup Wi-Fi, `wifi-floppy-XXXX` (password
   `wififloppy`). The setup page opens by itself, or browse to `http://192.168.4.1/`. Enter
   your Wi-Fi network, its password and the code.
4. Done. The board joins your network and appears under Devices. Firmware updates now arrive
   over the air from the web app.

If your phone has joined this board's setup network before, forget that network first. More
detail, and what to do when a join fails, is in
[wifi-floppy/README.md](wifi-floppy/README.md#first-install).

## Screenshots

The pictures come from a demo account holding freely redistributable disks: scene demos and
freeware tools. `PORT=3100 pnpm screenshots` takes them again (see
`e2e/screenshots.shots.ts`).

![The library: seven titles in a grid, with Demozoo covers for the demos](docs/screenshots/library.png)

*The library. Titles are identified against TOSEC and Demozoo; the 9 Fingers card is
highlighted because its disk is in a drive.*

![A title page for 9 Fingers: Demozoo facts and screenshots, then its two disks with Download, Browse, Eject and Mount](docs/screenshots/game.png)

*A title page: facts and screenshots from Demozoo, then each disk with its actions.*

![The file browser for the SysInfo disk: volume details, the file tree, and a history panel with three versions](docs/screenshots/disk-files.png)

*Inside a disk. Each edit made here is a new version in the history panel at the bottom.*

![The Devices page: one board, A500, online, with a drive-front card whose display shows 9 Fingers loaded](docs/screenshots/devices.png)

*A board on the Devices page. The card's display shows what the board's OLED shows.*

![The display editor open on the A500 card: a 128x32 preview and a list of elements with size options](docs/screenshots/display-editor.png)

*The display editor: choose the panel, then which elements the OLED draws and where.*

![The Help page, open at Boards: pairing, online and offline, firmware updates](docs/screenshots/help.png)

*Help explains the parts that are not obvious.*

<img src="docs/screenshots/library-phone.png" width="300" alt="The library on a phone: one column of controls, two columns of covers, and the tab bar at the bottom">

*The library at phone width.*

## Features

### Library

- Upload `.adf`, `.adz`, `.dms` and `.hfe`; drop `.lha`, `.lzh` and `.zip` archives onto a disk
  to pick files out of them.
- HD (1.76 MB) ADFs are recognised and tagged HD, and are disks like any other: browsed
  and edited in the browser, with full history. Blank HD disks can be made from the
  New disk panel.
- Each unique disk is stored once, however many times it is uploaded.
- Disks are identified against TOSEC, OpenRetro and Demozoo, and grouped into titles
  with cover art, screenshots, publisher, year and type.
- Collections, search as you type, and a layout that works on a phone.
- Create a blank formatted disk: 880 KB or 1.76 MB, OFS or FFS.
- Download any disk as an ADF.

### Inside a disk

- Browse the AmigaDOS filesystem in the browser: files, folders, free space.
- Add, rename, move and delete files and folders; drop a folder from your computer
  onto a disk; drag entries between folders.
- Every change is a new version. The history panel shows what changed in each
  version, lets you browse any old version, and restores one as a new version.
- HFE images (including long-track formats such as Turrican's) play read-only and can
  be extracted to an ADF when every sector decodes.

### The drive

- Set up from a phone: the board opens a WiFi setup page, you enter your network and
  a pairing code from the web app, and it joins your library.
- Mount and eject from the web app, from the drive chips in the header, or by
  tapping an NFC tag.
- Reads and writes on a real Amiga. Saves reach the library as new disk versions,
  including saves made while the board was offline.
- Works as DF0 or alongside a second drive as DF1.
- Plays HD disks: the board tells the Amiga it is an HD drive while an HD disk is in.
  Needs Kickstart 3.0 or later. Playing needs firmware 1.4.1 or later (the web app
  refuses to mount an HD disk on older firmware and says so); saving to an HD disk
  needs 1.5.0 (1.4.x keeps HD write-protected on the board whatever the web app
  says).
- Write protection can be switched from the web app while the disk is in the drive.
- OLED status display: WiFi strength, what it is doing, the disk's name and the
  current track. An activity LED blinks on reads.
- Updates its own firmware from the web app. Releases are signed, a failed update
  falls back to the previous firmware, and the board never updates while a disk is
  in the drive.

### NFC tags

- Tap a tag on the drive to mount its disk. Tapping another tag swaps disks; tapping
  the one already in the drive does nothing.
- Write any disk to a tag from its library card or game page: click the NFC icon,
  tap a tag on the drive, and the result appears in the browser.
- A tag only ever mounts disks from your own library.
- Reader: HW-147C (Si512), on the board's I2C bus next to the OLED.

## How it works

An Amiga floppy drive does not deliver blocks. It hands Paula a raw magnetic flux
stream and the Amiga decodes MFM in software, so a drive emulator has to produce flux
at the right rate, continuously, while the disk spins.

```
  browser  ──mount──▶  web app  ──encodes ADF → MFM──▶  device  ──flux──▶  Amiga
     ▲                    │                                │
     └──── new version ◀──┴── Postgres + blobs     RP2350 + 8 MB PSRAM ◀── NFC tag
```

The server encodes a 901,120-byte ADF into 2,027,536 bytes of Amiga MFM and the board
streams it: PIO emits 2 µs bitcells, DMA restarts each revolution and raises INDEX,
giving 300 rpm. The whole disk lives in PSRAM, so a seek is answered immediately
instead of over the network. The board streams flux rather than ADFs, which lets
flux formats such as HFE use the same path.

An HD disk is the exception. The server sends the board the ADF itself (a small
WFAD header, then 1,802,240 bytes), and the board encodes each track to MFM as the
head reaches it, in about 4 ms, well inside the head's settle time. A PIO program
answers the Amiga's drive-ID read on RDY with the HD ID while an HD disk is mounted.
When the Amiga saves to an HD disk, the board checks all 22 sectors of the written
track, keeps them as ADF bytes, and uploads those bytes as they are.

When the Amiga writes, the board decodes the written tracks, uploads them, and the
server records them as a new version of the disk. Versions are stored as sector
deltas.

## Status

| | |
|---|---|
| Web app: library, collections, identification, search | live |
| Upload `.adf` `.adz` `.dms` `.hfe`; `.lha`/`.lzh`/`.zip` onto a disk | live |
| File editing inside a disk, blank disks, drag and drop | live |
| Disk history: browse and restore any version | live, restore verified on hardware |
| Device: setup portal, WiFi, TLS, pairing | verified on hardware |
| Mount and eject from the browser and the drive chips | verified on hardware |
| Reading on a real Amiga (Workbench 3.1, games) | verified on hardware |
| Writing on a real Amiga, saves reach the library | verified on hardware |
| Second drive (DF1) alongside the board | verified on hardware |
| HFE, including long-track (Turrican) | verified on hardware; weak-bit titles not yet tested |
| HD disks, read-only (Kickstart 3.0+) | verified on hardware (firmware 1.4.1, Kickstart 3.1) |
| HD disks: Amiga saves, history, browser editing, blank HD disks | shipped in firmware 1.5.1; bench steps 4-7 owed (HANDOFF 3ao) |
| Firmware updates from the web app | verified on hardware (current release: 1.10.2) |
| NFC: tap to mount, write tags from the web | verified on hardware |
| Rev B board | built and running (Shanshe's design, `wifi-floppy/hardware/`) |

## Repository

| Path | What |
|---|---|
| `src/` | the Next.js app |
| `src/lib/adfmfm/` | ADF ⇄ Amiga MFM encoder, verified against Greaseweazle |
| `src/lib/adffs/` | AmigaDOS filesystem reader/writer (OFS/FFS) |
| `src/lib/archive/` | `.lha`/`.lzh`, `.zip` and `.dms` decoders, all browser-side |
| `src/lib/hfe/` | HFE parsing, conversion for the board, ADF extraction |
| `src/lib/disk-history/` | sector deltas and the version chain behind history and restore |
| `src/lib/nfc/` | NFC tap and tag-writing rules and storage |
| `wifi-floppy/firmware/` | the RP2350 firmware (pico-sdk ≥ 2.3.0) |
| `wifi-floppy/hardware/` | the board (KiCad) |
| `docs/superpowers/specs/` | design specs, one per feature |
| `HANDOFF.md` | the engineering log: decisions, measurements, bench results |

## Running it

```bash
pnpm install
pnpm db:dev start         # a local Postgres 18 in Docker; prints its DATABASE_URL
pnpm db:migrate           # apply drizzle/ to DATABASE_URL (there is no db:push)
pnpm dev                  # needs .env.local: DATABASE_URL, BETTER_AUTH_SECRET,
                          # BETTER_AUTH_URL (BLOB_READ_WRITE_TOKEN is optional)
pnpm test                 # vitest, pure logic
pnpm e2e                  # playwright, against the database in .env.local
bash scripts/e2e-local.sh # playwright with no Vercel or Neon: a fresh local
                          # Postgres and local storage; arguments go to playwright
```

Stored files (disk images, covers, firmware) go to local disk under `./data/blobs`
(`STORAGE_DIR` moves it) unless `BLOB_READ_WRITE_TOKEN` is set, in which case they go to
Vercel Blob. On Vercel the token is required: the app refuses to fall back to local disk there.

A self-hosted copy needs no extra setting: the About page (the (i) at the top right) reads
**Self-hosted** unless `SELFHOSTED=false`, which only our own deployment sets. A Docker build
without `.git` can pass `GIT_SHA` so the About page shows the commit.

Firmware:

```bash
export PICO_SDK_PATH=/path/to/pico-sdk        # tag 2.3.0 or later
pnpm firmware:build
pnpm firmware:test                            # host tests, no board needed
pnpm firmware:publish --dry-run               # sign and register a release
```

Write a disk to an NFC tag from the command line:

```bash
pnpm nfc:write "Turrican II disk 1"           # then tap a tag on the drive
```

The setup access point uses the password **`wififloppy`** by default. Set
`PORTAL_AP_PASSWORD` at build time to change it. The pairing code from the web app is
what authorises a board to join a library.

Putting the firmware on a new board is the [Quickstart](#quickstart) above: one
`wifi-floppy-install-<version>.uf2` from the GitHub release, dragged onto the drive that
appears while BOOT is held at power-up. With picotool, `pnpm firmware:install-partitioned` still works.

Every push that touches the firmware is built by
[`.github/workflows/firmware.yml`](.github/workflows/firmware.yml), which runs the host
tests and publishes a `.uf2` with a `manifest.json` (version, commit, size, SHA-256).

## Verification

Each layer that talks to hardware or to an undocumented format is checked against an
independent implementation:

| | checked against |
|---|---|
| `pnpm adfmfm:diff` | Greaseweazle's `amigados` codec |
| `pnpm adffs:verify` | `xdftool` |
| `pnpm lha:verify` | the real `lha` binary |
| `pnpm dms:verify` | xDMS, the implementation ours was ported from |

## Licence

- **Software** (the web app, scripts and the wifi-floppy firmware source): [MIT](LICENSE).
- **Hardware** (`wifi-floppy/hardware/`, the board design): [CERN-OHL-P-2.0](wifi-floppy/hardware/LICENSE), the
  permissive open-hardware licence, so anyone can build, modify and sell their own boards. The rev B PCB layout is
  Shanshe's work, licensed this way with Shanshe's agreement; see
  [wifi-floppy/hardware/NOTICE.md](wifi-floppy/hardware/NOTICE.md).
- **Third-party code, the libraries in the firmware image, and acknowledgements**: see
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The Wi-Fi driver bundled with the Pico SDK is licensed for use
  on Raspberry Pi chips (which this board is).

This project builds on Nano-Tek, OpenFlops, Keir Fraser's FlashFloppy and Greaseweazle, and the other work credited
in the notices file.
