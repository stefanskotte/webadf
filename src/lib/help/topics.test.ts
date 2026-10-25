import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HELP_TOPICS, HELP_ORDER, HELP_GROUPS, helpGroupOf, type HelpTopicId } from './topics';

const IDS: HelpTopicId[] = ['library', 'boards', 'own-server', 'nfc', 'next-disk', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display', 'second-drive', 'network', 'send', 'from-amiga', 'cover-image', 'about', 'preferences'];
// Internal words a reader of the help should never meet (spec §5).
const BANNED = /\b(PSRAM|TBYB|poll|sha256|cursor|WPROT)\b/i;

// Sentence ends: . ! ? followed by a space or the end -- but not "e.g." / "i.e." or a number like "1.7".
function sentences(s: string): number {
  return s.split(/(?<!\be\.g|\bi\.e)[.!?](?=\s|$)/).filter((p) => p.trim().length > 0).length;
}

function bodyText(id: HelpTopicId): string {
  return renderToStaticMarkup(HELP_TOPICS[id].body as React.ReactElement)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
}

describe('help topics', () => {
  it('has exactly the spec topics', () => {
    expect(Object.keys(HELP_TOPICS).sort()).toEqual([...IDS].sort());
  });

  it('lists every topic once in the table of contents', () => {
    expect([...HELP_ORDER].sort()).toEqual([...IDS].sort());
    expect(new Set(HELP_ORDER).size).toBe(HELP_ORDER.length);
  });

  for (const id of IDS) {
    it(`${id}: a title, a 1-2 sentence short, no internal words`, () => {
      const t = HELP_TOPICS[id];
      expect(t.title.trim().length).toBeGreaterThan(0);
      expect(sentences(t.short)).toBeGreaterThanOrEqual(1);
      expect(sentences(t.short)).toBeLessThanOrEqual(2);
      expect(t.short).not.toMatch(BANNED);
    });

    it(`${id}: a body of roughly 80-200 words, no internal words`, () => {
      const text = bodyText(id);
      const words = text.split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(60);
      expect(words).toBeLessThanOrEqual(280);
      expect(text).not.toMatch(BANNED);
    });
  }
});

// Final review fixes (2026-10-05): claims that were wrong, incomplete or unverifiable.
describe('help topics say what the app really does', () => {
  it('from-amiga names the firmware, the three ways to send, the key digits and the limits (spec 2026-10-18)', () => {
    const b = HELP_TOPICS['from-amiga'].short + bodyText('from-amiga');
    for (const w of ['1.19.0', 'Install', 'Send…', 'Transfer SEND', 'Trusted board AB12', 'Trust this board', 'TRUST',
      '4 MB', '500 files', '256 MB', '30 days', '24 hours', 'Clear finished', 'Add to library', 'Open title', 'Stop',
      'Staging']) expect(b).toContain(w);
    expect(b).not.toContain('Clear all');   // gone with the one list (spec 2026-10-23 decision 2)
  });
  it('send describes the one Staging list and every board\'s files (spec 2026-10-23)', () => {
    const b = bodyText('send');
    for (const w of ['Staging', 'To the Amiga', 'Clear finished', 'every board']) expect(b).toContain(w);
  });
  it('from-amiga lists every extension the library takes', () => {
    expect(bodyText('from-amiga')).toMatch(/ADF, DSK, ADZ, DMS, DMZ and HFE/);
  });
  it('from-amiga says Transfer trusts the first board it meets and the four digits are how to check it', () => {
    const b = bodyText('from-amiga');
    expect(b).toMatch(/first board/);
    expect(b).toMatch(/four digits/);
  });
  it('library describes the table: folders, the way up, the card controls, filing by drag, and the default view (2026-10-21)', () => {
    const b = HELP_TOPICS.library.short + bodyText('library');
    for (const w of ['folder', '↑ Library', 'All titles', 'Library opens in', '⋯', 'version history', 'mount', 'NFC',
      'remove from the collection', 'delete', 'grid only']) expect(b).toContain(w);
  });
  it('preferences names the default library view', () => {
    const b = bodyText('preferences');
    expect(b).toContain('Library opens in');
    expect(b).toMatch(/Grid or Table/);
  });
  it('preferences names the three start pages, says they follow the person, and that a collection keeps its order', () => {
    const b = bodyText('preferences');
    for (const w of ['Library', 'Devices', 'Upload']) expect(b).toContain(w);
    expect(b).toMatch(/every browser/);
    expect(b).toMatch(/collection keeps its own order/);
  });
  it('display names the turn (1.17.0) and the counter\'s side arrow, and no longer a head element', () => {
    const t = bodyText('display');
    expect(t).toMatch(/Rotation/);
    expect(t).toMatch(/180°/);
    expect(t).toMatch(/upside down/);
    expect(t).toMatch(/1\.17\.0/);
    expect(t).toMatch(/arrow/);
    expect(t).toMatch(/side/);
    expect(t).toMatch(/42↑79/);
    expect(t).not.toMatch(/\bhead\b/);
    expect(t).not.toMatch(/40\.1/);
  });
  it('nfc names the tag types that work: MIFARE Classic 1K, and NTAG213/215/216 from fw 1.18.1', () => {
    const b = HELP_TOPICS.nfc.short + bodyText('nfc');
    expect(b).toMatch(/MIFARE Classic 1K/);
    expect(b).toMatch(/NTAG213, NTAG215 or NTAG216/);
    expect(b).toMatch(/1\.18\.1/);
    expect(b).not.toMatch(/not recognised/);
  });
  it('nfc: another kind of tag shows "Tag: not supported"; a blank one "Tag: not a disk tag" (fw 1.18.1 nfc_ui.c)', () => {
    const b = bodyText('nfc');
    expect(b).toMatch(/Tag: not supported/);
    expect(b).toMatch(/Tag: not a disk tag/);
  });
  it('nfc explains the reader line on the board card (fw 1.17.0 boot scan: 0x28, and 0x24 for a PN532)', () => {
    const b = bodyText('nfc');
    expect(b).toMatch(/0x28/);
    expect(b).toMatch(/0x24/);
    expect(b).toMatch(/1\.17\.0/);
  });
  it('nfc: the Si512 works; PN532 support is new in 1.18.0 and still being tested (no PN532 has run on hardware)', () => {
    const b = HELP_TOPICS.nfc.short + bodyText('nfc');
    expect(b).toMatch(/Si512/);
    expect(b).toMatch(/PN532/);
    expect(b).toMatch(/1\.18\.0/);
    expect(b).toMatch(/being tested/);
    expect(b).not.toMatch(/Both kinds of red reader module work/);
    expect(b).not.toMatch(/PN532[^.]*not supported/);
  });
  it('nfc: a PN532 is looked for only at start-up (fw 1.18.0 needs the boot scan to see 0x24)', () => {
    expect(bodyText('nfc')).toMatch(/restart the board after connecting/);
  });
  it('library: says where the DF0 pill sits in the grid and in the table, and that it reads amber while fetching', () => {
    const b = bodyText('library').replace(/\s+/g, ' ');
    expect(b).toMatch(/on the card.{0,3}s picture/);
    expect(b).toMatch(/in the table after the name/);
    expect(b).toMatch(/amber DF0…/);
    expect(b).not.toMatch(/shows a DF0 pill on its picture/);
  });
  it('boards gives the setup network password and the Update + password step', () => {
    const b = bodyText('boards');
    expect(b).toMatch(/wififloppy/);
    expect(b).toMatch(/Update/);
    expect(b).toMatch(/password/);
    expect(b).toMatch(/give the board a name/);
  });
  it('boards and preferences say the firmware password can be turned off in Settings, and what that costs', () => {
    expect(bodyText('boards')).toMatch(/unless you turned that off in Settings/);
    const p = bodyText('preferences');
    expect(p).toMatch(/Firmware updates/);
    expect(p).toMatch(/takes your password/);
    expect(p).toMatch(/signed-in browser/);
  });
  it('write-protect makes no unconfirmed claim about prompts to click through', () => {
    expect(bodyText('write-protect')).not.toMatch(/click through|put the volume back/i);
  });
  it('next-disk ties "Saving, then N/M" to the Next-disk card, the only case that shows it', () => {
    const b = bodyText('next-disk');
    const sentence = b.split(/(?<=[.!?])\s+/).find((s) => s.includes('Saving, then'));
    expect(sentence).toBeDefined();
    expect(sentence).toMatch(/Next-disk card/);
    expect(sentence).not.toMatch(/Saving, then disk/);   // firmware 1.15.0 dropped the word
  });
  it('next-disk says a disk change shows an empty drive first, so the insert request closes by itself', () => {
    const b = bodyText('next-disk');
    expect(b).toMatch(/empty drive\s+for about a second/);
    expect(b).toMatch(/Please insert volume/);
    expect(b).toMatch(/Before firmware 1\.15\.0/);
  });
  it('disk-sets describes the board line without the word Disk, as firmware 1.15.0 prints it', () => {
    const b = bodyText('disk-sets');
    expect(b).toMatch(/2\/13 Locale/);
    expect(b).toMatch(/before 1\.15\.0/);
  });
  it('hd-hfe says the board must be able to play HD', () => {
    expect(bodyText('hd-hfe')).toMatch(/boards? that can play HD/i);
  });
});

describe('boards address note', () => {
  it('boards says the address may change once after 1.11.0 (plan 2026-10-12 ruling 26)', () => {
    expect(bodyText('boards')).toMatch(/1\.11\.0[^.]*new network address once/);
  });
});

describe('second-drive states every caveat the operator asked for', () => {
  const all = () => HELP_TOPICS['second-drive'].short + ' ' + bodyText('second-drive');
  it('DF1 is read-only: saves fail as write-protected', () => expect(all()).toMatch(/write-protected/i));
  it('takes effect at the next Amiga restart, cold or warm', () => {
    expect(all()).toMatch(/restart/i);
    expect(all()).toMatch(/Ctrl-Amiga-Amiga|warm/i);
  });
  it('only when no other drive is DF1, naming both kinds', () => {
    expect(all()).toMatch(/external drive/i);
    expect(all()).toMatch(/second internal drive/i);
  });
  it('big boxes: the external port is DF2 there', () => expect(all()).toMatch(/DF2/));
  it('DF1 empties for about five seconds on Next disk', () => expect(all()).toMatch(/five seconds|5 seconds/i));
  it('the next disk of the set, or a disk you mount into DF1 (spec 2026-10-14)', () => {
    expect(all()).toMatch(/next disk of the set/i);
    expect(all()).toMatch(/mount[^.]*into DF1/i);
    expect(all()).toMatch(/Eject DF1/);
    expect(all()).toMatch(/standard DD disks only/i);
    expect(all()).toMatch(/1\.12\.0/);
  });
  // A4 (2026-10-23) brings back the approved board's names in place of D4's "On": both choices are the stored 'df1'.
  it('names the choices Next disk of the set and Any disk', () => {
    expect(bodyText('second-drive')).toMatch(/Choose\s+Next disk of the set\s+under/);
    expect(bodyText('second-drive')).toMatch(/choose\s+Any disk\s+and mount/);
    expect(bodyText('second-drive')).not.toMatch(/Choose\s+On\s+under/);
  });
  it('the refusal and its override', () => {
    expect(all()).toMatch(/refuse/i);
    expect(all()).toMatch(/anyway/i);
  });
  it('names the firmware it needs', () => expect(all()).toMatch(/1\.9\.0/));
  it('older firmware keeps the stored setting (final review I2)', () => {
    expect(all()).toMatch(/older firmware keeps the DF1 setting/i);
  });
  it('an HD next disk leaves DF1 empty', () => expect(all()).toMatch(/HD disk, DF1 stays empty|HD[^.]*empty/i));
});

describe('network says what a regular user needs (spec 2026-10-12 §5)', () => {
  const all = () => HELP_TOPICS.network.short + ' ' + bodyText('network');
  it('names the setting and the restart', () => {
    expect(all()).toMatch(/Network \(PaulaNET\)/);
    expect(all()).toMatch(/restart/i);
  });
  it('what you need: a TCP/IP stack and no other DF1 -- and DF0 may be empty (ruling 6)', () => {
    expect(all()).toMatch(/AmiTCP_NG/); expect(all()).toMatch(/Roadshow/);
    expect(all()).toMatch(/no other drive/i);
    expect(all()).toMatch(/DF0 can be empty/i);
    expect(all()).not.toMatch(/keep a disk|waiting for a disk/i);
  });
  it('the three steps', () => {
    expect(all()).toMatch(/Install/); expect(all()).toMatch(/AddNetInterface eth0/); expect(all()).toMatch(/User-Startup/);
  });
  it('honest numbers and the mouse', () => {
    expect(all()).toMatch(/45 KB\/s/); expect(all()).toMatch(/half/i); expect(all()).toMatch(/250 ms/);
    expect(all()).toMatch(/mouse/i);
  });
  it('the download and the credit', () => {
    expect(renderToStaticMarkup(HELP_TOPICS.network.body as React.ReactElement)).toContain('href="/api/paulanet-disk"');
    expect(bodyText('network')).toMatch(/LZ4/);
    expect(bodyText('network')).toMatch(/installed PaulaNET before, run Install again from the driver disk in DF1/i);
    expect(all()).toMatch(/Rob Smith/);
  });
  it('names the firmware it needs', () => expect(all()).toMatch(/1\.11\.0/));
});

describe('send names the limits, Transfer, the expiry and the accepted risk', () => {
  it('send names the limits, Transfer, the expiry and the accepted risk', () => {
    const s = HELP_TOPICS.send.short + bodyText('send');
    expect(s).toMatch(/Transfer/);
    expect(s).toContain('Transfer RECEIVE');                  // the Shell form (Transfer 2.1)
    expect(s).toMatch(/replacing\s+Receive/);                 // Install deletes the old C:Receive
    expect(s).toMatch(/4 MB/);
    expect(s).toMatch(/24 hours/);
    expect(s).toMatch(/1\.15\.0/);
    expect(s).toMatch(/any computer on your network/);
    expect(s).toMatch(/keeps its older driver disk until the Amiga has been off/);
  });
});

describe('second-drive names the third option (spec 2026-10-12 §5)', () => {
  it('Network (PaulaNET), linked to its topic', () => {
    expect(HELP_TOPICS['second-drive'].short + bodyText('second-drive')).toMatch(/Network \(PaulaNET\)/);
    expect(renderToStaticMarkup(HELP_TOPICS['second-drive'].body as React.ReactElement)).toContain('href="/help#network"');
  });
});

describe('cover-image says what the upload accepts and what Revert does', () => {
  const all = () => HELP_TOPICS['cover-image'].short + ' ' + bodyText('cover-image');
  it('names the four types and the 2 MB cap', () => {
    expect(all()).toMatch(/PNG/); expect(all()).toMatch(/JPEG/); expect(all()).toMatch(/GIF/); expect(all()).toMatch(/WebP/);
    expect(all()).toMatch(/2 MB/);
  });
  it('names both buttons as they read on the page', () => {
    expect(all()).toMatch(/Change image/); expect(all()).toMatch(/Revert to default/);
  });
  it('says the choice is per organization', () => expect(all()).toMatch(/your organization only/i));
});

// Disk at startup (2026-10-19, src/lib/boot-disk.ts): the setting, what No disk does, and when it does not apply.
describe('boards explains Disk at startup', () => {
  it('names both choices, that No disk waits for a tap, and that an update or a network drop keeps the disk', () => {
    const b = bodyText('boards');
    expect(b).toMatch(/Disk at startup/);
    expect(b).toMatch(/Last disk/);
    expect(b).toMatch(/No disk/);
    expect(b).toMatch(/insert-disk screen/);
    expect(b).toMatch(/firmware update/);
    expect(b).toMatch(/Wi-Fi/);
    expect(b).toMatch(/1\.18\.1/);
  });
});

describe('help names Board settings (Devices C2)', () => {
  it('boards sends Disk at startup and deleting a board to Board settings, not to the card or a trash icon', () => {
    const b = bodyText('boards');
    expect(b).toMatch(/Board settings/);
    expect(b).toMatch(/Save to board/);
    expect(b).toMatch(/Delete device…\s+in\s+Board settings/);
    expect(b).not.toMatch(/trash icon/);
  });
  it('nfc: "No reader found?" names Board settings and its dot', () => {
    const b = bodyText('nfc');
    expect(b).toMatch(/Board settings/);
    expect(b).toMatch(/dot/);
  });
});

describe('boards explains the stuck-start line (fw 1.18.2 boot trail)', () => {
  it('names the card line and the firmware', () => {
    const t = bodyText('boards');
    expect(t).toMatch(/Previous start stopped at/);
    expect(t).toMatch(/1\.18\.2/);
  });
});

describe('help groups (C5 spec §3.1, Ruling 14)', () => {
  it("are the board's four, in its order, with these topics", () => {
    expect(HELP_GROUPS.map((g) => [g.id, g.name])).toEqual([
      ['drives', 'Drives'], ['disks', 'Library and disks'], ['network', 'Amiga networking'], ['server', 'This server'],
    ]);
    expect(HELP_GROUPS[0].topics).toEqual(['boards', 'display', 'second-drive', 'next-disk', 'nfc', 'write-protect']);
    expect(HELP_GROUPS[1].topics).toEqual(['library', 'write-back', 'disk-sets', 'hd-hfe', 'cover-image']);
    expect(HELP_GROUPS[2].topics).toEqual(['network', 'send', 'from-amiga']);
    expect(HELP_GROUPS[3].topics).toEqual(['preferences', 'own-server', 'about']);
  });
  it('put every topic in exactly one group, and HELP_ORDER is the groups flattened', () => {
    const all = HELP_GROUPS.flatMap((g) => g.topics);
    expect([...all].sort()).toEqual([...IDS].sort());
    expect(new Set(all).size).toBe(17);
    expect(HELP_ORDER).toEqual(all);
    expect(helpGroupOf('library').name).toBe('Library and disks');
    expect(helpGroupOf('write-protect').id).toBe('drives');
  });
});
