/** The page's h1: where focus goes when the control that held it is removed (C6 spec §8). Client-side only. */
export function pageHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>('h1');
}
