// DF1 second drive (spec docs/superpowers/research/2026-10-08-df1-second-drive.md).
// Texts for the device card's readings: both values of each state, in words.

export function sel1Text(wired: boolean): string {
  return wired ? 'DF1 line: connected' : 'DF1 line: no signal yet';
}

export function df1SeenText(seen: boolean): string {
  return seen ? 'Other DF1 drive: detected' : 'Other DF1 drive: none seen';
}
