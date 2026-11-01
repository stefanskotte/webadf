# Amiga networking and file transfer

The WiFi floppy board can put your Amiga on your network, as drive DF1, and move files both ways between the Amiga and
the web app. This guide covers setting it up, the Transfer program on the Amiga, and what the web app's Files page does
with it. The same text, shorter, is in the web app's help (the **?** beside each part).

## What you need

- The board in **Network (PaulaNET)** mode: choose it in the *Second drive (DF1)* box on the board's card on the
  Devices page, then restart the Amiga.
- A TCP/IP stack on the Amiga, such as AmiTCP_NG or Roadshow, and no other drive answering as DF1.
- Kickstart 2.04 or newer. A 512 KB Amiga is not enough: the TCP/IP stack alone leaves too little chip memory.
- Board firmware, by feature (the board updates itself from the Devices page):

| Feature | Firmware | Transfer |
|---|---|---|
| The network (PaulaNET) | 1.11.0 | — |
| Send files to the Amiga | 1.15.0 | any |
| Send files from the Amiga to the web app | 1.19.0 | 2.1 |
| The web app reads the Amiga's volumes (Read) | 1.22.0 | 2.3 |
| The web app changes them (Write) | 1.23.0 | 2.5 |
| A Move off a volume removes only what it copied | 1.23.1 | 2.6 |

## Setting up the network

1. With the board in Network mode, DF1 holds the **PaulaNET driver disk**, whatever is in DF0. (For a real floppy or
   an emulator, download it from the web app: `/api/paulanet-disk`.)
2. Open DF1 and double-click **Install**. It copies the driver to `DEVS:Networks`, writes `DEVS:NetInterfaces/eth0`
   (unless one is there already), and copies **Transfer** to `SYS:Tools` (with its icon) and `C:`.
3. In a Shell, type `AddNetInterface eth0`. To go online at every start, add that line to `S:User-Startup`.

The board's card shows a checklist for each part: the driver disk, the driver, and the Amiga's own address. Expect about
45 KB/s, about half that during a DF0 copy. With firmware 1.16.0 or newer the driver compresses with LZ4: what the Amiga
receives on every Amiga, and what it sends on a 68020 or faster. If you installed PaulaNET before, run Install again to
get it.

PaulaNET is by Rob Smith (RobSmithDev), used with his permission. The driver disk carries WebFloppy's LZ4 build of his
driver.

## Transfer

Transfer is the Amiga program that saves files the web app sends, sends files up to it, and, when you allow it, lets the
web app read and change your disks. Its window, *WebFloppy - Receive & Send*, has:

- **Save files to:** the folder files sent to the Amiga go into (**Choose…**, then **Save**). The default is `RAM:`.
- **Send…**, **Retry failed**, and **Trust this board**.
- **Web App: Read Write**: two switches, both off until you tick them. *Read* lets the web app list the Amiga's volumes
  and copy files off them. *Write* also lets it change them. Write needs Read. Transfer remembers both.
- The status line and the list of files: waiting, receiving NN %, done, or failed with the reason.

### Starting it

- **From its icon** in `SYS:Tools`, or **in a Shell**: `Transfer RECEIVE`.
- **With Workbench:** copy `SYS:Tools/Transfer` **and** `SYS:Tools/Transfer.info` into `SYS:WBStartup`. Copy both: the
  icon carries the `DONOTWAIT` tool type, without which Workbench stops at "Program 'Transfer' has not yet returned".
  Running Install again later updates a Transfer it finds in `SYS:WBStartup`, and its icon if the icon is from before
  Transfer 2.7.
- Transfer is a **commodity** (2.7 and newer): its close gadget only hides the window, and it keeps working.
  **Ctrl-Alt-W** shows the window again; Exchange can show, hide, disable or quit it, and so does *Project ▸ Quit*.
- The icon's tool types: `CX_POPUP=NO` starts it without the window, `CX_POPKEY` changes the hot key, `TO=<folder>`
  sets the folder for that run.

### Trust

Transfer trusts the first board it meets: it saves that board's key and shows four of its digits, such as *Trusted board
AB12*. The same four digits appear on your board's row under NET: on the Files page (*key AB12*). Transfer talks only to
that board; **Trust this board** (or `Transfer TRUST`) accepts another one.

## Sending files to the Amiga

On the **Files** page:

- drop files or a folder on **Send files to the Amiga**, or press *Choose files* (with more than one board, pick the
  board under it);
- or copy files or folders into **NET:** and the board, from a disk or from STASH:;
- or, on a title's page, press **Send .adf to Amiga** to send a whole disk as one file.

Each file waits under NET: and the board's **Queue**: waiting, sending, delivered with the name it was saved as, or failed
and why. **Delete** on a waiting or sending file cancels it, and on a finished one clears it.

- Up to 4 MB a file, and up to 32 files or 16 MB waiting for one board.
- A file sent while Transfer is closed waits up to 24 hours, then expires.
- Nothing is overwritten: a second `Foo.lha` arrives as `Foo_2.lha`.

## Sending files from the Amiga

Drop files or drawers on Transfer's window, press **Send…**, or type `Transfer SEND DH0:file` in a Shell. They land in
**STASH:** on the Files page. From there you can download them, copy them onto a disk, send them
on, or, for a disk image, **Add to library**.

- Up to 4 MB a file. STASH: holds up to 500 files or 256 MB for your organization, and keeps each file 30 days.
- A file cut off by a reset or a lost connection continues where it stopped when you send it again within 24 hours.

To put Amiga files onto a disk: in LIBRARY:, **Create ADF…** makes a blank disk as a new title. Open it in one pane
and STASH: in the other, and copy the files in (F5).

## The Amiga's own disks

With **Read** ticked in Transfer, NET: and the board list the Amiga's volumes beside the Queue. Open drawers and copy
files off them to STASH: or LIBRARY:. Each drawer takes a few seconds to read; one read in the last 2 minutes opens at
once and says when it was read, and **Refresh** (Ctrl-R) reads it again.

With **Write** ticked too, the web app can copy and move files onto a volume, make drawers, rename, set protection bits
and comments, and delete:

- **Delete** always asks, and cannot be undone; the `.info` goes along.
- A **Move** removes only what it copied: a file saved into the source meanwhile is kept, and the Move says so.
- Nothing is forced. A write-protected or full disk, a file protected from deletion, or one in use is said in words,
  with no requester on the Amiga.
- Unticking Write while a file is being copied onto a volume stops it: the old file stays as it was.

## When something does not work

| The web app says | What to do |
|---|---|
| *Transfer is not running on <board>* | Start Transfer on the Amiga. |
| *Tick Read in Transfer on <board>* | Tick *Read* in Transfer's window. |
| *Writing is off in Transfer* | Tick *Write* in Transfer's window. |
| *Transfer 2.3 or newer is needed on <board>*, *Transfer 2.5 or newer writes to the Amiga*, *Move needs Transfer 2.6 — use Copy* | Run Install again from the driver disk in DF1 to get the current Transfer. |
| *Board firmware 1.23.0 or newer writes to the Amiga* | Update the board from the Devices page. |
| *<board> didn't answer — Refresh to try again* | Check that the Amiga is online (`AddNetInterface eth0`), then Refresh. |

- **Workbench says "Program 'Transfer' has not yet returned"** at start: the Transfer in `SYS:WBStartup` is older than
  2.7, or its icon lacks `DONOTWAIT`. Run Install again, or copy both files from `SYS:Tools` over it.
- **Files wait and never arrive**: Transfer is not running, or trusts another board (check the four key digits).
- **No network after a restart**: add `AddNetInterface eth0` to `S:User-Startup`.
- **Install still gives an old Transfer**: a board whose Amiga was running when a new driver disk came out keeps the
  older disk in DF1 until the Amiga has been off a while; switch it off, then on, and run Install again.
