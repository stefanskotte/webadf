import { PANEL_W } from '@/lib/display-editor-geometry';

/**
 * Paint a display.wasm framebuffer onto a canvas `zoom` pixels per panel
 * pixel. SSD1306 page layout: byte (page * 128 + x), bit (y % 8). Lit pixels
 * only -- the caller's canvas background is the dark glass.
 */
export function paintFramebuffer(
  ctx: CanvasRenderingContext2D, fb: Uint8Array, rows: number, zoom: number, lit: string,
) {
  ctx.fillStyle = lit;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < PANEL_W; x++) {
      if (fb[(y >> 3) * PANEL_W + x] & (1 << (y & 7))) ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
    }
  }
}
