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
  // Sources: pair-button.tsx, devices/page.tsx:58-68, device-state.ts:19 (60 s),
  // firmware-state.ts:107-148, HANDOFF trial/revert (5546-5577) and "waits for eject" (2064, 5148).
  // Deleting a board: delete-device-dialog.tsx + api/devices/[id] DELETE; the board's side (401 -> token erased ->
  // setup portal, same already-used code rejected, so a fresh code is asked for) is wifi-floppy/firmware/src/main.c
  // DC_HALTED branch; disk history kept because disk_versions.device_id has no FK (db/schema/disk-history.ts).
  boards: {
    title: 'Boards',
    short:
      'A board is the WiFi floppy drive plugged into your Amiga. Pair it once with a code from this page, and from then on it plays whatever you mount here.',
    body: (
      <>
        <p>
          <strong>Pairing.</strong> Press <em>Pair a device</em> to get a short code. A new board starts its own Wi-Fi
          network named <em>wifi-floppy-…</em> (password <em>wififloppy</em>); join it, and in the page that opens
          enter your home Wi-Fi details and the code. If the code runs out first, mint a new one.
        </p>
        <p>
          <strong>Online / Offline.</strong> A board counts as online while it has been heard from in the last minute.
        </p>
        <p>
          <strong>Firmware updates.</strong> When a newer version is published, tick <em>Select for update</em> on the
          board, press <em>Update</em> and confirm with your password. Its card then shows <em>update queued</em>,{' '}
          <em>downloading</em> and <em>applying — do not power off</em>. A new version first runs on trial: if it doesn&apos;t start up and check in within 5 minutes, the
          board goes back to the version it had by itself, and the card says <em>update failed</em> with the reason.
        </p>
        <p>
          <strong>Deleting a board.</strong> The trash icon on a board&apos;s card removes it from your account. The
          board then offers its setup network again the next time it connects, and a new code pairs it again; your
          disks and their history stay.
        </p>
        <GoodToKnow items={[
          'A board never updates while a disk is mounted — the update waits for the eject.',
          'Updates also wait until the Amiga is switched on and the drive is idle.',
        ]} />
      </>
    ),
  },

  // Sources: nfc/fob-button.tsx (flow, 120 s wait, texts), devices/page.tsx:19,59 (Next-disk card, fw 1.6.0+),
  // HANDOFF tap-to-mount (5248-5296) and Next-disk card (4968-4971).
  nfc: {
    title: 'NFC cards',
    short:
      'Stick an NFC sticker or fob on a real floppy case, link it to a disk here, and tapping it on the board mounts that disk. A Next-disk card instead moves whatever is mounted to its next disk.',
    body: (
      <>
        <p>
          <strong>Linking a tag.</strong> Use MIFARE Classic 1K tags; other kinds, such as the common NTAG stickers,
          are not recognised. Press the NFC button on a disk — it only appears when one of your boards has
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
        <GoodToKnow items={['Next-disk cards need board firmware 1.6.0 or newer.']} />
      </>
    ),
  },

  // Sources: drive-chips.ts:14-18 (preload texts), next-disk-button.tsx, drive-chips.tsx:332,
  // HANDOFF next disk (4960-4991) and the swap gate (4811-4880: 3 s idle, 20 s forced, OLED text).
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
          card during that wait, its display shows <em>Saving, then disk N</em> for a moment.
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
  // ingest/set-suggestion.tsx, card-mount-button.tsx:211, HANDOFF disk sets (4902-4941).
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
  display: {
    title: "The board's display",
    short:
      "Choose the panel fitted to the board and arrange what its screen shows. The preview is drawn by the board's own code, so it matches the real panel pixel for pixel.",
    body: (
      <>
        <p>
          The screen on each board&apos;s card is drawn the same way, from its saved layout and the disk it last
          reported; the board does not send download progress or the track, so those are not shown. Press{' '}
          <em>Change Display</em>, or the screen itself, to open the editor.
        </p>
        <p>
          Pick the <em>Panel</em> (128×32 or 128×64) and drag elements into place; each can be shown or hidden, at 1×
          or 2×. <em>Preview as</em> shows other situations, such as downloading or a long title.
        </p>
        <p>
          The <em>nfc</em> icon, hidden until you tick it, shows the NFC reader: the contactless mark when it works,
          struck through when none is found, a solid square while a tag write waits for a tap.
        </p>
        <p>
          After <em>Save</em> the status reads <em>Waiting for the board</em>, then <em>Applied on the board</em>, or
          why the board refused it. <em>Cancel</em> discards unsaved changes and closes the editor;{' '}
          <em>Reset to default</em> restores the standard layout.
        </p>
        <p>
          Your layout is used while the board is running: ready, downloading and with a disk mounted. The start-up,
          setup, connecting and error screens always use the standard 128×32 layout (at the top of a 128×64 panel), so
          a board can be set up whatever its layout.
        </p>
        <GoodToKnow items={[
          'Display layouts need board firmware 1.7.1 or newer; the NFC icon needs 1.10.0.',
          '0.91" (128×32) and 0.96" (128×64) panels use the SSD1306 chip. Most 1.3" (128×64) panels use the SH1106 chip, which needs firmware 1.7.4 or newer.',
          'Unplug the board before changing its panel: it checks which chip the panel has only when it starts up.',
        ]} />
      </>
    ),
  },
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
  'second-drive': {
    title: 'Second drive (DF1)',
    short:
      'The board can also be your DF1, holding the next disk of the set, so games that read disk 2 from DF1 need no swapping. Off unless you switch it on.',
    body: (
      <>
        <p>
          Choose <em>Next disk of the set</em> under <em>Second drive (DF1)</em> on the board&apos;s card. DF1 then
          holds the disk after the one in DF0, if that is a standard (DD, 880K) disk; when it is an HD disk, DF1 stays empty. When you press <em>Next disk</em>, DF0 moves on at once and DF1 is
          empty for about five seconds while the following disk is fetched.
        </p>
        <p>
          The change takes effect when the Amiga restarts, cold or warm: switch the Amiga off and on, or press
          Ctrl-Amiga-Amiga. Switching it off works the same way: until the Amiga restarts, DF1 stays there, empty and
          write-protected.
        </p>
        <p>
          Use it only when no other drive is DF1. On an A500, A600 or A1200 that means no external drive. On an
          A2000, A3000 or A4000 it means no second internal drive; the external port there is DF2, which the board
          does not affect. If the board has seen another drive answer as DF1, the setting refuses to switch on. After
          removing that drive you can override it with <em>Switch on anyway…</em> and a second confirmation.
        </p>
        <GoodToKnow items={[
          'DF1 is read-only: saving to it fails as write-protected. Saves to DF0 follow that disk’s own write protection.',
          'DF1 only ever holds the next disk of the set. You cannot pick another disk for it.',
          'Needs board firmware 1.9.0 or newer. A board put back on older firmware keeps the DF1 setting it had, and the card says DF1 is on while it holds a disk; install 1.9.0 or newer to switch it off.',
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
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;

export const HELP_ORDER: readonly HelpTopicId[] = [
  'boards', 'nfc', 'next-disk', 'second-drive', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display',
  'cover-image',
];
