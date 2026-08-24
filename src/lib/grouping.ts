import { parseTosecName } from './tosec';

export interface IncomingDisk { filename: string; sha256: string; sizeBytes: number }

export interface GroupedGame {
  title: string;
  sortTitle: string;
  year: number | null;
  publisher: string | null;
  disks: Array<{
    diskNo: number; sha256: string; filename: string; sizeBytes: number; isBoot: boolean;
  }>;
}

export function groupDisks(input: IncomingDisk[]): GroupedGame[] {
  const byKey = new Map<string, GroupedGame>();

  for (const item of input) {
    const parsed = parseTosecName(item.filename);
    // Year is part of the key: two releases of the same title in different
    // years are different games, not disks of one game.
    const key = `${parsed.sortTitle}::${parsed.year ?? ''}`;

    let game = byKey.get(key);
    if (!game) {
      game = {
        title: parsed.title, sortTitle: parsed.sortTitle,
        year: parsed.year, publisher: parsed.publisher, disks: [],
      };
      byKey.set(key, game);
    }

    if (game.disks.some((x) => x.sha256 === item.sha256)) continue;

    game.disks.push({
      diskNo: parsed.diskNo ?? 1,
      sha256: item.sha256,
      filename: item.filename,
      sizeBytes: item.sizeBytes,
      isBoot: false,
    });
  }

  const games = [...byKey.values()];
  for (const g of games) {
    g.disks.sort((a, b) => a.diskNo - b.diskNo);
    for (const disk of g.disks) disk.isBoot = disk.diskNo === 1;
  }
  games.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
  return games;
}
