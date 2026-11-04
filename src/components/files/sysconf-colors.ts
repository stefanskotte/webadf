// The Amiga's 12-bit colours and the browser's colour control. CLIENT-SAFE.
/** 0x68B is #6688bb: each 4-bit channel doubled, which is how the Amiga's 15 steps reach full white. */
export function colorToCss(c: number): string {
  return `#${[c >> 8, c >> 4, c].map((n) => (n & 0xF).toString(16).repeat(2)).join('')}`;
}
/** The nearest 12-bit colour to one the browser's control gives. */
export function cssToColor(css: string): number {
  return [1, 3, 5].reduce((acc, at) => (acc << 4) | Math.round(parseInt(css.slice(at, at + 2), 16) / 17), 0);
}
