import type { ReactNode } from 'react';

// Context help (spec docs/superpowers/specs/2026-10-05-context-help-design.md).
// One source for the "?" popovers (title + short) and the /help page (body).
// Every claim here was checked against the code/HANDOFF named beside it --
// change the behaviour, change the text.

export type HelpTopic = { title: string; short: string; body: ReactNode };

function GoodToKnow({ items }: { items: ReactNode[] }) {
  return (
    <>
      <p className="font-semibold">Good to know</p>
      <ul className="list-disc pl-5">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </>
  );
}

export const HELP_TOPICS = {
  // Sources: library/page.tsx (view from ?view= else prefs library.view; no overview in the table),
  // game-table.tsx + library-table.ts (folders at the root, the up row), title-controls.tsx (the shared controls
  // and their order), view-toggle.tsx (keeps the collection), collection-provider.tsx onDragEnd (a row files on a
  // rail drop only; reorder and card-on-card sets are the grid's), preferences-form.tsx (Library opens in, Titles per
  // page), library-pager.tsx + library-paging.ts (?page=, Per page saves the preference, a new size or sort goes to
  // page 1), library-table.ts (folders on page 1 only).
  library: {
    title: 'Library',
    short:
      'Your titles, as a grid of cards or as a condensed table with the same controls. The table shows your collections as folders.',
    body: (
      <>
        <p>
          <strong>Grid or table.</strong> The grid and table buttons at the top of the page switch views and keep the
          collection you are in. <em>Library opens in</em> under Preferences in Settings picks the view the library starts in: the
          grid unless you change it.
        </p>
        <p>
          <strong>Folders.</strong> In the table, the library&apos;s first page lists each collection as a folder,
          with how many titles and disks it holds, before the titles that are in no collection. Open a folder to
          see its titles; <em>↑ Library</em> at the top takes you back. <em>All titles</em> has the same way back.
        </p>
        <p>
          <strong>Pages.</strong> The grid and the table show your titles a page at a time: 48 unless you change it,
          with <em>Per page</em> under the list or <em>Titles per page</em> under Preferences in Settings (24, 48, 96,
          192 or All). Changing it, or the sort, starts again at page 1. Switching between grid and table keeps the
          page you are on. In the table, the folders are on the first page.
        </p>
        <p>
          <strong>Controls.</strong> Each row has the card&apos;s buttons in the same order: version history, mount
          or eject, write an NFC tag (when you have a reader), remove from the collection (inside one) and delete. A
          disk in a drive is marked round its picture, and a disk you made here can be renamed in place.
        </p>
        <p>
          <strong>Filing.</strong> Drag a card or a row onto a collection in the collections list. Reordering a
          collection, and making a disk set by dropping one title on another, are grid only.
        </p>
      </>
    ),
  },

  // Sources: pair-button.tsx, devices/page.tsx:58-68, device-state.ts:19 (60 s),
  // firmware-state.ts:107-148, HANDOFF trial/revert (5546-5577) and "waits for eject" (2064, 5148).
  // Deleting a board: delete-device-dialog.tsx + api/devices/[id] DELETE; the board's side (401 -> token erased ->
  // setup portal, same already-used code rejected, so a fresh code is asked for) is wifi-floppy/firmware/src/main.c
  // DC_HALTED branch; disk history kept because disk_versions.device_id has no FK (db/schema/disk-history.ts).
  // Address note: plan 2026-10-12 ruling 4 -- 1.11.0 sends the board's own DHCP client-id.
  // Naming at pairing: pair-button.tsx, api/devices/pair + device/register (plan 2026-10-17 R8).
  // Disk at startup: lib/boot-disk.ts + boot-disk-store.ts (cleared at a new boot's first request; not on the same
  // boot id or an &ota=1 boot), boot-disk-setting.tsx, firmware fw_trial.h (the update-reboot mark), BOOT_DISK_FW.
  // Stuck-start line: lib/last-boot.ts describeLastBoot, device-card.tsx; firmware boot_trail.h (fw 1.18.2).
  boards: {
    title: 'Boards',
    short:
      'A board is the WiFi floppy drive plugged into your Amiga. Pair it once with a code from this page, and from then on it plays whatever you mount here.',
    body: (
      <>
        <p>
          <strong>Pairing.</strong> Press <em>Pair a device</em>, give the board a name
          and press <em>Get a code</em>. A new board starts its own Wi-Fi
          network <em>wifi-floppy-…</em> (password <em>wififloppy</em>); join it and enter your home Wi-Fi details and
          the code.
        </p>
        <p>
          <strong>Online / Offline.</strong> A board is online if heard from in the last minute.
        </p>
        <p>
          <strong>Firmware updates.</strong> Tick <em>Select for update</em> on the board, press <em>Update</em> and
          confirm with your password (unless you turned that off in Settings). The card shows <em>update queued</em>,{' '}
          <em>downloading</em> and <em>applying — do not power off</em>. A new version runs on trial: if it doesn&apos;t
          check in within 5 minutes, the board goes back to its old version and the card says <em>update failed</em>.
        </p>
        <p>
          <strong>Disk at startup.</strong> <em>Last disk</em> (the default) puts the board&apos;s disk back at power-up.{' '}
          <em>No disk</em> leaves the drive empty: the Amiga waits at its insert-disk screen until you tap a card or
          mount one. A firmware update or a Wi-Fi drop keeps the disk. Needs firmware 1.18.1.
        </p>
        <p>
          <strong>Stuck start?</strong> The card then says where, e.g.{' '}
          <em>Previous start stopped at: I2C scan</em> (firmware 1.18.2). Include it in reports.
        </p>
        <p>
          <strong>Deleting a board.</strong> The trash icon removes a board from your account. Your disks and their history stay.
        </p>
        <p>
          <strong>Your own server.</strong> Running your own copy? See{' '}
          <a className="underline" href="/help#own-server">Your own server</a>.
        </p>
        <GoodToKnow items={[
          'An update waits until no disk is mounted, the Amiga is on and the drive is idle.',
          'After updating to firmware 1.11.0, your router may give the board a new network address once.',
        ]} />
      </>
    ),
  },

  // Sources: nfc/fob-button.tsx (flow, 120 s wait, texts), devices/page.tsx:19,59 (Next-disk card, fw 1.6.0+),
  // HANDOFF tap-to-mount (5248-5296) and Next-disk card (4968-4971).
  // Reader line: lib/i2c-scan.ts describeI2cScan (wording, 0x28 / 0x24 PN532 / 0x3c-0x3d display), device-card.tsx;
  // firmware i2c_scan.h (boot scan only, fw 1.17.0). Two reader chips: firmware nfc_reader.h (Si512 at 0x28 first,
  // then a PN532 at 0x24, fw 1.18.0). Tag kinds: nfc_reader_priv.h nfc_classify (MIFARE Classic 1K; NTAG21x from
  // fw 1.18.1); the "not a disk tag" / "not supported" lines are nfc_ui.c's.
  nfc: {
    title: 'NFC cards',
    short:
      'Stick an NFC sticker or fob on a real floppy case, link it to a disk here, and tapping it on the board mounts that disk. A Next-disk card instead moves whatever is mounted to its next disk.',
    body: (
      <>
        <p>
          <strong>Linking a tag.</strong> Use MIFARE Classic 1K tags or NTAG213, NTAG215 or NTAG216 stickers. A
          blank one shows &ldquo;Tag: not a disk tag&rdquo;; any other kind shows &ldquo;Tag: not supported&rdquo;.
          Press the NFC button on a disk — it only appears when one of your boards has
          an NFC reader. Pick the disk and the board, then hold the tag on that board&apos;s reader within two
          minutes. Lift any tag that is already on the reader first: the board never writes to a tag that was lying
          there when you started.
        </p>
        <p>
          <strong>Tapping.</strong> Tapping a tag mounts its disk. Tapping the disk that is already in the drive does
          nothing. The tag stores which disk it is, so it keeps working after the Amiga has saved to that disk.
        </p>
        <p>
          <strong>Next-disk card.</strong> Write one with <em>Write a Next-disk card</em> on the Devices page. Tapping
          it moves a multi-disk game on to its next disk.
        </p>
        <p>
          <strong>Readers.</strong> Modules with an Si512 chip (address 0x28) work. PN532 modules (0x24) are new
          and still being tested; restart the board after connecting one. With both fitted, the Si512 is used.
        </p>
        <p>
          <strong>No reader found?</strong> Each board card says whether the board found its reader when it
          started, and what else answered: the display, or nothing at all. Check the reader&apos;s wires, then
          restart the board.
        </p>
        <GoodToKnow items={[
          'Next-disk cards need board firmware 1.6.0 or newer.',
          'The reader line on the card needs firmware 1.17.0 or newer.',
          'A PN532 reader needs firmware 1.18.0 or newer.',
          'NTAG stickers need firmware 1.18.1 or newer.',
        ]} />
      </>
    ),
  },

  // Sources: drive-chips.ts:14-18 (preload texts), next-disk-button.tsx, drive-chips.tsx:332,
  // HANDOFF next disk (4960-4991) and the swap gate (4811-4880: 3 s idle, 20 s forced, OLED text).
  // The empty second: wifi-floppy/firmware/src/swap_phase.h (SWAP_EMPTY_MS 1000, DF0 and DF1, every disk-over-disk
  // change; fw 1.15.0); trackdisk then reports the insertion at its next change check, up to ~2.5 s later.
  'next-disk': {
    title: 'Next disk and preloading',
    short:
      'Next disk steps a multi-disk game on to its next disk, in the disk set’s order. The board loads that disk ahead of time, so the swap is close to instant.',
    body: (
      <>
        <p>
          Use the <em>Next: disk N</em> button on the board&apos;s card, the drive menu, or a Next-disk card. After the
          last disk it wraps around to the first.
        </p>
        <p>
          <strong>Preloading.</strong> The line under the board shows <em>Disk N ready (instant swap)</em>,{' '}
          <em>Disk N loading…</em> or <em>Disk N not preloaded yet</em>. The board only preloads when it has nothing
          else to do, such as saves still to send or an update.
        </p>
        <p>
          <strong>Why a swap sometimes waits.</strong> After a save, the Amiga goes on writing for a moment. Taking
          the disk away then would damage it, just like ejecting a real floppy with the drive light on. So the board
          swaps only when the drive light is off and nothing has been written for 3 seconds. When you tap a Next-disk
          card during that wait, its display shows <em>Saving, then 2/3</em> (the next disk, of how many) for a moment.
        </p>
        <p>
          <strong>The empty second.</strong> When one disk replaces another, the board shows the Amiga an empty drive
          for about a second first, as a real swap would. A <em>Please insert volume</em> request then closes by
          itself. Before firmware 1.15.0 you may have to click <em>Retry</em>.
        </p>
        <GoodToKnow items={[
          'If the drive stays busy without writing (some games keep the motor running), the board swaps anyway after 20 seconds of quiet.',
        ]} />
      </>
    ),
  },

  // Sources: history-panel.tsx (labels, Restore dialog, mounted refusal), disk-history/history.ts:98-107,
  // HANDOFF write-back (3188-3215), restore (2975-2982), re-dating (4813-4863, volume-date.ts).
  'write-back': {
    title: 'Saves and the time machine',
    short:
      'When the Amiga saves to a writable disk, the change is sent here and kept as a new version. The History lists every version, and you can browse or restore any of them.',
    body: (
      <>
        <p>
          A save arrives a few seconds after the Amiga stops writing. If you eject or swap sooner, the board finishes
          sending first. Each version in the History says where it came from: <em>As uploaded</em>,{' '}
          <em>Edited in browser</em>, <em>Amiga: &lt;board&gt;</em> or <em>Restored to version N</em>.
        </p>
        <p>
          <strong>Restore</strong> adds the old version back as the newest one. Nothing is thrown away, so you can
          restore forward again. A disk that is mounted on a board can&apos;t be restored — eject it there first.
        </p>
        <p>
          <strong>Why a restored disk gets a new date.</strong> The Amiga recognises a disk by its creation date and
          name. If a restored disk looked exactly like the one it remembers, it could write its old memory of that
          disk back onto it. So a restore moves the disk&apos;s creation date on by one tick (a fiftieth of a second),
          and the Amiga treats it as a different disk.
        </p>
        <GoodToKnow items={[
          'Because of that date, a restored disk is not byte-for-byte the old version.',
          'Disks that are not standard AmigaDOS, such as many games, are restored exactly.',
        ]} />
      </>
    ),
  },

  // Sources: write-protect-toggle.tsx:38 (labels + tooltips), catalog.ts:142 (default protected),
  // HANDOFF write protect (1900-1901, 3113-3125, 3199-3202), disk-row.tsx:155-159 (HFE).
  'write-protect': {
    title: 'Write protection',
    short:
      'Writable lets the Amiga save to this disk, and each save becomes a new version here. Protected makes the disk read-only for the Amiga, like sliding the tab on a real floppy.',
    body: (
      <>
        <p>
          New disks start <em>Protected</em>. The setting belongs to the disk, so it goes with the disk to whichever
          board mounts it.
        </p>
        <p>
          You can change it while the disk is mounted: the board tells the Amiga the disk was taken out and put back,
          so the Amiga notices the new setting.
        </p>
        <GoodToKnow items={[
          'The board can also protect a disk by itself, when this site refuses its saves (for example because the disk was changed here meanwhile). It stays protected until the disk is mounted again.',
          'HFE disks are always read-only.',
        ]} />
      </>
    ),
  },

  // Sources: disk-set-section.tsx:166-175 (header texts), add-disks-dialog.tsx, disk-set-menu.tsx:58-100,
  // ingest/set-suggestion.tsx, card-mount-button.tsx:211, HANDOFF disk sets (4902-4941), disk-label.ts (the OLED name).
  'disk-sets': {
    title: 'Disk sets',
    short:
      'A disk set is a title with several disks, such as a multi-disk game or a Workbench install. Its order is the order Next disk steps through.',
    body: (
      <>
        <p>
          <strong>Making a set.</strong> When you upload loose disks that seem to belong together, the upload page
          suggests <em>These N disks look like one set</em>. You can also use <em>Add disks…</em> on a title, choose{' '}
          <em>Add to a disk set…</em> from a single disk&apos;s menu, or drag one library card onto another.
        </p>
        <p>
          <strong>Ordering.</strong> Press <em>Reorder</em> and drag, or use the ⋯ menu&apos;s <em>Move up</em>,{' '}
          <em>Move down</em> and <em>Move out of set</em>. Once you have arranged a set yourself, automatic renumbering
          leaves it alone.
        </p>
        <p>
          <strong>Mounting.</strong> The mount button on a set&apos;s library card asks which disk, and which board if
          you have more than one.
        </p>
        <p>
          <strong>On the board&apos;s screen.</strong> A mounted disk of a set shows as <em>2/13</em> followed by its
          name, such as <em>2/13 Locale</em>: the disk&apos;s Amiga volume name, else the name of the file you
          uploaded, without its extension. The screen has room for about 16 characters of it. Firmware before 1.15.0
          shows <em>Disk 2/13</em> instead.
        </p>
      </>
    ),
  },

  // Sources: create-adf.tsx:181 (HD, Kickstart 3.x), hfe/messages.ts (texts), extract-action.tsx,
  // HANDOFF HD (5000-5100), HFE long tracks (5326-5413), copy protection (1553-1569).
  'hd-hfe': {
    title: 'HD disks and HFE images',
    short:
      'HD disks hold 1.76 MB and need Kickstart 3.x on the Amiga. HFE images store a disk as its raw magnetic signal, so they can hold games an ordinary ADF cannot, but they are play-only.',
    body: (
      <>
        <p>
          <strong>HD disks.</strong> Create one from <em>New disk</em>, or upload one. They mount only on boards that
          can play HD; saving to them needs board firmware 1.5.0 or newer.
        </p>
        <p>
          <strong>HFE images.</strong> Some games use tracks longer or stranger than a normal disk&apos;s (Turrican is
          one), which an ADF cannot hold. An HFE image keeps them. If a board&apos;s firmware is too old for a
          disk&apos;s longest track, mounting it says so.
        </p>
        <p>
          <strong>Extract as ADF</strong> makes an ordinary, editable ADF copy of an HFE disk, when every part of it
          is standard AmigaDOS. Otherwise the disk is marked play only.
        </p>
        <GoodToKnow items={[
          'A copy-protected original can boot from an ADF and still not be complete: the protection check can fail quietly later in the game. A version with the protection removed avoids that.',
          'Weak-bit copy protections are not supported.',
        ]} />
      </>
    ),
  },

  // Sources: display-editor.tsx, drive-bezel.tsx, live-display.ts, display-editor-geometry.ts:172-178 (status texts), HANDOFF 3ax;
  // panel chips and the boot-time check: wifi-floppy/firmware/src/ssd1306.c (detect_sh1106, ssd1306_init), HANDOFF 3az.
  // NFC icon: display.c draw_nfc (present / struck = absent / inverted = write armed), main.c ui.nfc (armed wins,
  // then g_nfc_reader), display_layout.h EL_NFC (in no default), display-layout.ts NFC_ELEMENT_FIRMWARE 1.10.0,
  // display-editor.tsx withNfc (hidden by default; not offered below 1.10.0), display-store.ts (server refuses it).
  // Status icon: display.c STATUS_ICON (hourglass, mast, wifi arcs blinking, empty floppy, magnifier, filled
  // floppy, triangle blinking; downloading = draw_status_icon filling the empty floppy bottom-up with the percent,
  // full only at 100 %), display_layout.h STATUS_OPT_ICON (opt 1; the word in every default),
  // display_layout_for (built-in screens take the icon), display-layout.ts STATUS_ICON_FIRMWARE 1.15.0.
  // Rotation (1.17.0): oled_cmds.c (A0/C0 in the controller, every screen turns), display_layout.h
  // REC_ROTATION, display-editor.tsx (Rotation select, reset keeps the turn), drive-bezel.tsx (stripRotation), route.ts tooOldReason.
  // Track counter side arrow (1.18.0): display.c track_text ("42" arrow "79", down = side 0, up = side 1).
  // The 1.17.0 head element (id 10) was withdrawn; stored layouts that name it lose it silently.
  display: {
    title: "The board's display",
    short:
      "Choose the panel fitted to the board and arrange what its screen shows. The preview is drawn by the board's own code, so it matches the real panel pixel for pixel.",
    body: (
      <>
        <p>
          Each board&apos;s card shows its screen, drawn from its layout and last reported disk. Press <em>Change Display</em>, or the screen, to edit it.
        </p>
        <p>
          Pick the <em>Panel</em> (128×32 or 128×64) and drag elements into place, shown or hidden, at 1× or 2×.{' '}
          <em>Preview as</em> shows other situations. <em>Rotation</em> 180° turns every screen for a board mounted
          upside down; the preview and the card&rsquo;s screen stay upright.
        </p>
        <p>
          The <em>track</em> counter reads cylinder, a side arrow, then the last cylinder, as{' '}
          <em>42↑79</em> or <em>42↓79</em>: up is side 1, down is side 0. The <em>nfc</em> element, hidden until you tick it, shows
          the NFC reader (struck through when none is found, inverted while a tag write waits).
        </p>
        <p>
          The <em>status</em> shows <em>as</em> a word or a small icon: an empty or filled floppy, filling while
          downloading, blinking arcs while connecting, a blinking triangle on error.
        </p>
        <p>
          After <em>Save</em> it reads <em>Waiting for the board</em>, then <em>Applied on the board</em> or why the
          board refused it. <em>Cancel</em> discards unsaved changes;{' '}
          <em>Reset to default</em> restores the standard layout and keeps the rotation.
        </p>
        <p>
          Your layout is used while the board runs; other screens use the standard
          128×32 layout, with your status choice.
        </p>
        <GoodToKnow items={[
          'Display layouts need board firmware 1.7.1 or newer; the NFC icon 1.10.0; the status icon 1.15.0; rotation 1.17.0; the side arrow 1.18.0.',
          '0.91" (128×32) and 0.96" (128×64) panels use the SSD1306 chip; most 1.3" (128×64) panels the SH1106, which needs firmware 1.7.4 or newer.',
          'Unplug the board before changing its panel: it detects the chip only at start-up.',
        ]} />
      </>
    ),
  },
  // Network (PaulaNET): spec 2026-10-12 §1 (one setting, three values).
  // Sources: control texts and override buttons "Switch on anyway…" / "Yes, I have removed the other DF1 drive
  // — switch DF1 on": plan docs/superpowers/plans/2026-10-08-df1-second-drive.md Task 21 (second-drive-setting.tsx
  // runs after this task and must keep them identical); src/lib/second-drive.ts (SECOND_DRIVE_FW 1.9.0,
  // DF1_SEEN_REASON, saveSecondDrive refuses unless override; off is never refused); firmware: DF1 always
  // write-protected -> saves fail as "write-protected" (bench 2026-10-09 `echo >df1:x`); restart: Kickstart reads
  // drive IDs at every reset (Task 19; bench: DF1 survives Ctrl-Amiga-Amiga; switching off while running leaves an
  // empty, write-protected DF1 until the restart); device_client.c dc_df1_want (only the verified next disk; after
  // Next disk DF0 changes at once, DF1 empty ~4 s on the bench, 4.1 s measured); big boxes: spec
  // docs/superpowers/research/2026-10-08-df1-second-drive.md §2 (second internal drive is DF1, external port is DF2,
  // J1 has no SEL2) -- from the spec, not the bench. Kickstart 1.3 deliberately not mentioned (not bench-verified).
  // "cold or warm": a warm restart re-reads the live setting; a cold one (the board is powered by the Amiga) reads
  // the board's stored setting, which main.c's DF1 store block writes once both drives are empty OR the Amiga is idle
  // with a disk in (drive_store_should_write/drive_store_idle: both motors off and no write activity for 3 s, no
  // unsent saves; Ruling R17, final review C1) -- so seconds after the change, with the drive light off. Bench: Task
  // 24's store step. Older firmware (I2): 1.8.x boots with the stored DF1 setting and reports the disk DF1 serves,
  // but cannot take a change -- second-drive.ts DF1_ON_OLD_FIRMWARE, shown when df1Sha256 is non-null.
  // HD next disk: device_client.c dc_df1_want (returns SLOT_NONE for SLOT_KIND_ADF_HD unless _df1_hd_ok) and
  // wifi-floppy/firmware/CMakeLists.txt:181 WF_DF1_HD OFF (decision D2: DF1's buffer is DD-only) -> DF1 stays empty.
  // DF1 any disk (spec 2026-10-14): the setting is "On" (stored 'df1'); Mount offers DF0/DF1 (mount-action.tsx,
  // card-mount-button.tsx), standard DD only, Eject DF1 on the card (second-drive-setting.tsx), fw 1.12.0
  // (df1-pick.ts DF1_PICK_FW); a pick works with DF0 empty and survives DF0 changes (device_client.c dc_df1_want).
  'second-drive': {
    title: 'Second drive (DF1)',
    short:
      'The board can also be your DF1: it holds the next disk of the set, or a disk you mount into DF1, so games that read a second disk from DF1 need no swapping. Off unless you switch it on.',
    body: (
      <>
        <p>
          Choose <em>On</em> under <em>Second drive (DF1)</em> on the board&apos;s card. DF1 then holds the next disk
          of the set (empty when that is an HD disk); after <em>Next disk</em> it is empty for about five seconds while
          the following disk is fetched.
        </p>
        <p>
          Or mount a disk of your choice into DF1: press <em>DF1</em> beside <em>DF0</em> where you mount a disk. DF1 keeps it whatever
          DF0 does, even with DF0 empty, until <em>Eject DF1</em> on the card; then it follows the set again. DF1
          takes standard DD disks only.
        </p>
        <p>
          It takes effect when the Amiga restarts, cold or warm: switch it off and on, or press Ctrl-Amiga-Amiga.
        </p>
        <p>
          Use it only when no other drive is DF1: no external drive on an A500, A600 or A1200, no second internal
          drive on an A2000, A3000 or A4000 (the external port there is DF2). If the board has seen another DF1, the
          setting refuses to switch on; after removing that drive, use <em>Switch on anyway…</em>.
        </p>
        <GoodToKnow items={[
          'DF1 is read-only: saving to it fails as write-protected. Saves to DF0 follow that disk’s own write protection.',
          <>The third choice, <em>Network (PaulaNET)</em>, uses DF1 for networking instead: see{' '}
            <a className="underline" href="/help#network">Amiga networking</a>.</>,
          'On needs board firmware 1.9.0 or newer, and a disk of your choice in DF1 needs 1.12.0; Network needs 1.11.0. Older firmware keeps the DF1 setting it had, and the card says DF1 is on while it holds a disk; install 1.9.0 or newer to switch it off.',
        ]} />
      </>
    ),
  },

  // Sources: spec docs/superpowers/specs/2026-10-12-paulanet-phase3-network-setting-design.md §1-§5, §8; the
  // setting and checklist texts in second-drive-setting.tsx / network-checklist.ts; DF0 empty or changing: plan
  // 2026-10-12 ruling 6 (SLOT_NET, psram_image.h; the poll sends the driver disk in Network mode with or without a
  // disk in DF0 -- as `next` before fw 1.12.1, as DF1's pick `df1` from 1.12.1, NET_PICK_FW),
  // bench Task 14 Steps 5 and 14b;
  // numbers: HANDOFF 3bi (47.5 KB/s alone, 24.4 KB/s during a DF0 copy, router pings 204-545 ms, avg ~250);
  // the steps: tools/paulanet-disk/Install and ReadMe; download: api/paulanet-disk/route.ts; Rob's permission:
  // third-party/paulanet/PERMISSION.md. Mouse: the driver busy-polls at priority 1 (HANDOFF 3bi, not yet measured).
  // LZ4: spec 2026-10-18 (fw 1.16.0, the variant on the driver disk).
  network: {
    title: 'Amiga networking (PaulaNET)',
    short:
      'Put your Amiga on your network through the board’s Wi-Fi, with the board as drive DF1. It uses Rob Smith’s PaulaNET driver and a TCP/IP stack on the Amiga.',
    body: (
      <>
        <p>
          Choose <em>Network (PaulaNET)</em> under <em>Second drive (DF1)</em> on the board&apos;s card, then restart
          the Amiga. DF1 then holds the PaulaNET driver disk, whatever is in DF0. You need a TCP/IP stack such as
          AmiTCP_NG or Roadshow, and no other drive answering as DF1. If the board has seen another drive answer as DF1, the
          setting refuses to switch on; once you have removed that drive, override it with <em>Switch on anyway…</em>.
        </p>
        <p>
          <strong>Three steps.</strong> Open DF1 and double-click <em>Install</em>. Then, in a Shell, type{' '}
          <code>AddNetInterface eth0</code>. To go online at every start, add that line to S:User-Startup. The
          card&apos;s checklist shows each part: the driver disk, the driver, and the Amiga&apos;s own address.
        </p>
        <GoodToKnow items={[
          'Expect about 45 KB/s, about half that during a DF0 copy, and pings of about 250 ms.',
          'The mouse may feel slower while the driver runs.',
          'DF0 can be empty, for an Amiga that starts from a hard drive, and changing the disk in DF0 does not interrupt the network.',
          'Needs board firmware 1.11.0 or newer.',
          <>For a real floppy or an emulator, <a className="underline" href="/api/paulanet-disk">download the PaulaNET driver disk</a>.</>,
          'With board firmware 1.16.0, the driver compresses with LZ4: what the Amiga receives on every Amiga, and what it sends on a 68020 or faster. Already-compressed files travel as before. If you installed PaulaNET before, run Install again from the driver disk in DF1 to get it.',
          'PaulaNET is by Rob Smith (RobSmithDev), used with his permission. The driver disk carries webadf’s LZ4 build of his driver.',
        ]} />
      </>
    ),
  },

  // Sources: spec docs/superpowers/specs/2026-10-16-paulanet-phase4-send-to-amiga-design.md §1 (D4 limits, D8 never
  // overwrite, D9 accepted risk), §4 (the Upload page column, Browse Send, Send .adf), §5 (Receive, now Transfer, and Install);
  // src/lib/send-limits.ts (XFER_FW, limits), src/lib/send-ui.ts (the words), tools/paulanet-disk/Install;
  // plan 2026-10-17 rulings R1 (1.15.0), R9 (Cancel while sending), R10 (Retry).
  send: {
    title: 'Sending files to the Amiga',
    short:
      'Send files from your computer, or from a disk in your library, to a folder on your Amiga. The Amiga saves them with Transfer, from the PaulaNET driver disk.',
    body: (
      <>
        <p>
          Your board must be in <em>Network (PaulaNET)</em> mode, on firmware 1.15.0 or newer. On the Amiga, run{' '}
          <em>Install</em> from the driver disk once: it copies <em>Transfer</em> to SYS:Tools and C:, replacing{' '}
          <em>Receive</em>. Start it yourself (in a Shell: <em>Transfer RECEIVE</em>), choose a folder and press
          Save. The default folder is RAM:.
        </p>
        <p>
          <strong>Three ways to send.</strong> On the Upload page, drop any file under <em>Send to Amiga</em>. On a
          disk&apos;s Browse page, press <em>Send</em> on a file or a folder. On a title&apos;s page, press{' '}
          <em>Send .adf to Amiga</em> to send a whole disk as one file. The Upload page shows each file waiting, on its
          way, delivered with the name it was saved as, or failed with the reason.
        </p>
        <GoodToKnow items={[
          'Up to 4 MB a file, and up to 32 files or 16 MB waiting for one board.',
          'A file sent while Transfer is closed waits up to 24 hours, then expires.',
          'Nothing is overwritten: a second Foo.lha arrives as Foo_2.lha.',
          'Cancel stops a file that is waiting or on its way. Retry sends a failed one again from the start.',
          'Clear finished drops every delivered, failed, cancelled or expired file from the list.',
          'A board whose Amiga was running when a new driver disk came out keeps its older driver disk until the Amiga has been off a while; then it gets the new one.',
          'While Transfer runs, any computer on your network can drop a file into its folder. It cannot overwrite anything or leave the folder, and nothing is run.',
        ]} />
      </>
    ),
  },
  // Sources: spec docs/superpowers/specs/2026-10-18-amiga-to-web-upload-design.md §1 (U2 the ways to send, U4 resume,
  // U5 limits, U6 the area, U7 trust), §2 (Receive, now Transfer), §4 (Add to library, Clear all, attachments), §6 (the key digits);
  // src/lib/amiga-upload-limits.ts (UPLOAD_FW, limits), src/lib/from-amiga-ui.ts (the words), tools/receive/amiga/gui.c.
  'from-amiga': {
    title: 'Files from the Amiga',
    short:
      'Send files from your Amiga to the web app with Transfer. They land in From the Amiga on the Upload page, where you can download them, add disk images to your library or send them on.',
    body: (
      <>
        <p>
          Your board needs firmware 1.19.0 or newer, in <em>Network (PaulaNET)</em> mode. Run <em>Install</em> from the
          driver disk again to get <em>Transfer</em> (it replaces <em>Receive</em>), and start it. Then drop files or
          drawers on its window, press <em>Send…</em>, or type <em>Transfer SEND DH0:file</em> in a Shell.
        </p>
        <p>
          <strong>Your board, and only yours.</strong> Transfer trusts the first board it meets: it saves that
          board&apos;s key and shows four of its digits, such as <em>Trusted board AB12</em>. The same four digits appear
          on this page, so check they match your board. Transfer sends only to that board; if another one connects it
          stops, and <em>Trust this board</em> (or <em>TRUST</em> in the Shell) accepts the new one.
        </p>
        <GoodToKnow items={[
          'Up to 4 MB a file. The area holds up to 500 files or 256 MB for your organization, and keeps each file 30 days.',
          'A file cut off by a reset or a lost connection continues where it stopped when you send it again within 24 hours. A file marked Stopped can be sent again in that time, or deleted.',
          'Add to library is offered for ADF, DSK, ADZ, DMS, DMZ and HFE files; nothing is added on its own.',
          'Clear all removes every finished file you can see; a file still arriving stays.',
          'Download always saves the file: a web page sent from the Amiga is never opened in the browser.',
        ]} />
      </>
    ),
  },

  // Sources: cover-image.ts (types, 2 MB, 16-4096 px, effectiveCoverUrl precedence), cover-control.tsx
  // (button texts), api/games/[id]/cover/route.ts (Revert keeps nothing else), cover-override.ts (per-org row),
  // blob-gc-run.ts (unused images reclaimed within two weeks).
  'cover-image': {
    title: 'Cover images',
    short:
      'Give a title a picture of your own, such as a scan of the box for a utility nobody has catalogued. Revert to default puts back the cover found for it, if any.',
    body: (
      <>
        <p>
          <strong>Changing the image.</strong> On a title&apos;s page, press <em>Change image…</em> and pick a PNG,
          JPEG, GIF or WebP file of at most 2 MB, between 16 and 4096 pixels on each side. It replaces the cover on the
          title&apos;s page, on its library card and in the collection tiles it appears in.
        </p>
        <p>
          <strong>Which picture shows.</strong> Your own image always wins. Without one, the title uses the cover the
          automatic look-ups found for it, if any; with neither, the library card shows its plain placeholder.
        </p>
        <p>
          <strong>Going back.</strong> <em>Revert to default</em> removes your image from the title and the automatic
          cover returns. Nothing else about the title changes.
        </p>
        <GoodToKnow items={[
          'The image belongs to your organization only: other people who have the same disk keep seeing their own cover.',
          'An image no title uses any more is deleted from storage within two weeks.',
        ]} />
      </>
    ),
  },
  // Sources: spec 2026-10-15-board-server-override-design.md; commands in
  // wifi-floppy/firmware/src/serial_cmd.c, behaviour in main.c;
  'own-server': {
    title: 'Your own server',
    short:
      'If you run your own copy of this site, you can point a board at it. This needs firmware 1.13.0 or newer.',
    body: (
      <>
        <p>
          <strong>Setting it.</strong> Connect the board&apos;s USB port to a computer, open it in a serial terminal
          and type <code>wf server set https://your.host</code>. <code>wf server clear</code> goes back to this site.
          Eject any disk first: the board refuses to change the server while a disk is mounted.
        </p>
        <p>
          <strong>Setting up again.</strong> Changing the server means setting the board up again: it forgets its
          pairing and Wi-Fi, reboots into its setup network, and needs your Wi-Fi details and a new code from the new
          server.
        </p>
        <p>
          <strong>Self-signed certificate.</strong> For a home server with a self-signed certificate, also type{' '}
          <code>wf server tls noverify</code> and confirm with YES; the board then accepts any certificate, so use it
          only on a network you trust. The setting applies at the next boot.
        </p>
        <p>
          <strong>Updates.</strong> Firmware updates are still checked against our signing key, so a board on your own
          server only installs builds we signed. The full steps are in wifi-floppy/README.md.
        </p>
      </>
    ),
  },
  // Sources: spec 2026-10-15-about-page-design.md; src/lib/about/*; src/app/(app)/about/page.tsx.
  about: {
    title: 'About this server',
    short: 'What this copy of the site is: its build, where it runs, and how much your library stores.',
    body: (
      <>
        <p>
          <strong>Web app.</strong> The commit the site was built from, and when. On our own site the commit links to
          the change that produced it.
        </p>
        <p>
          <strong>Hosting.</strong> <em>Hosted</em> is this site, run by us. Anything else says <em>Self-hosted</em>:
          a copy someone runs on their own server. Nothing has to be set for that; every copy except ours reads
          self-hosted.
        </p>
        <p>
          <strong>Board firmware.</strong> The newest firmware your boards can install, and how many of your boards
          are behind it. The Devices page has the Update button.
        </p>
        <p>
          <strong>Your library.</strong> Your titles, disks and saved versions, and the space their disk images take.
          A disk image you hold twice is counted once. Other people&apos;s libraries are never included.
        </p>
      </>
    ),
  },
  // Sources: src/lib/user-prefs-schema.ts (choices, defaults), src/app/page.tsx + sign-in/page.tsx (start page),
  // library/page.tsx (sort skipped in a collection; ?view= else library.view), file-tree.tsx + browse-sort.ts (folders first),
  // components/prefs/preferences-form.tsx (saves as it changes), db/schema/user-prefs.ts (per user, not per org),
  // components/prefs/firmware-password-setting.tsx + api/me/prefs/firmware-skip-password (firmware password).
  preferences: {
    title: 'Preferences',
    short: 'Your own start page, library view and sort orders. They are kept with your account, so they follow you to every browser.',
    body: (
      <>
        <p>
          <strong>Start page.</strong> Where you land after signing in, and when you open the site&apos;s address:
          Library, Devices or Upload. Library unless you change it.
        </p>
        <p>
          <strong>Library opens in.</strong> Grid or Table: how the library shows when you open it. The grid and
          table buttons on the library switch for the moment without changing it.
        </p>
        <p>
          <strong>Titles per page.</strong> 24, 48 (the default), 96, 192 or All, in the grid and the table alike.
        </p>
        <p>
          <strong>Sort orders.</strong> The library&apos;s sort picker and the one above a disk&apos;s file list
          remember your choice as soon as you change it. The library starts with the newest added first; a
          disk&apos;s files start in name order, always with folders first. Inside a collection the sort picker is
          not shown: a collection keeps its own order, the one you set by dragging, and that order is shared with
          everyone in your organization.
        </p>
        <p>
          <strong>Changing them.</strong> Settings (the gear at the top) lists every preference in one place, and
          each change there is kept as soon as you make it.
        </p>
        <p>
          <strong>Firmware updates.</strong> Settings can stop <em>Update</em> on Devices asking for your password.
          Turning that on takes your password; turning it off does not. Settings says which applies:{' '}
          <em>Password asked</em> or <em>Password not asked</em>. While it is on, anyone using your signed-in browser
          can update your boards&apos; firmware.
        </p>
        <GoodToKnow items={[
          'Preferences are yours alone: others in your organization keep their own, and they follow you to every browser you sign in from.',
        ]} />
      </>
    ),
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;

export const HELP_ORDER: readonly HelpTopicId[] = [
  'library', 'boards', 'own-server', 'nfc', 'next-disk', 'second-drive', 'network', 'send', 'from-amiga', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display',
  'cover-image', 'about', 'preferences',
];
