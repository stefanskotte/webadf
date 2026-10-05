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

  // Sources: display-editor.tsx, display-editor-geometry.ts:172-178 (status texts), HANDOFF 3ax.
  display: {
    title: "The board's display",
    short:
      "Choose the panel fitted to the board and arrange what its screen shows. The preview is drawn by the board's own code, so it matches the real panel pixel for pixel.",
    body: (
      <>
        <p>
          Pick the <em>Panel</em> (128×32 or 128×64), then drag elements where you want them. Each element can be
          shown or hidden and drawn at 1× or 2×. <em>Preview as</em> shows the layout in different situations, such
          as downloading or with a long title.
        </p>
        <p>
          After <em>Save</em> the status reads <em>Waiting for the board</em>, then <em>Applied on the board</em> a
          moment later. If the board refuses a layout, it says why.
        </p>
        <p>
          Your layout is used while the board is running: ready, downloading and with a disk mounted. The start-up,
          setup, connecting and error screens always use the standard layout, so a board can still be set up and
          diagnosed whatever its layout.
        </p>
        <GoodToKnow items={['Display layouts need board firmware 1.7 or newer.']} />
      </>
    ),
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;

export const HELP_ORDER: readonly HelpTopicId[] = [
  'boards', 'nfc', 'next-disk', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display',
];
