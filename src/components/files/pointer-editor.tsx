'use client';

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { POINTER_SIZE, sysconfDefaults, type Ink } from '@/lib/files/sysconf';
import { colorToCss } from './sysconf-colors';

/** One cell of a pointer, in a new array: the rows are not changed in place. */
export function paint(pointer: string[], x: number, y: number, ink: Ink): string[] {
  return pointer.map((row, r) => (r === y ? `${row.slice(0, x)}${ink}${row.slice(x + 1)}` : row));
}

const INKS: { id: string; ink: Ink; label: string }[] = [
  { id: 'clear', ink: '.', label: 'Clear' }, { id: '1', ink: 'R', label: 'Colour 1' },
  { id: '2', ink: 'K', label: 'Colour 2' }, { id: '3', ink: 'W', label: 'Colour 3' },
];
const WORD: Record<Ink, string> = { '.': 'clear', R: 'colour 1', K: 'colour 2', W: 'colour 3' };
const CLEAR_LOOK = 'var(--input-bg)';

/**
 * The 16 x 16 pointer (spec 2026-11-04): pick an ink, press or drag across the cells; the Hot spot tool sets the pixel that
 * clicks. One tab stop: arrows move the cell, Space paints it or sets the hot spot. touch-none so a finger draws rather
 * than scrolls the dialog.
 */
export function PointerEditor(p: {
  pointer: string[]; hotSpot: { x: number; y: number }; colors: [number, number, number];
  onChange(next: { pointer: string[]; hotSpot: { x: number; y: number } }): void;
}) {
  const [ink, setInk] = useState<Ink>('K');
  const [hotTool, setHotTool] = useState(false);
  const [at, setAt] = useState({ x: 0, y: 0 });
  const grid = useRef<HTMLDivElement>(null);
  const look = (i: Ink) => (i === '.' ? CLEAR_LOOK : colorToCss(p.colors['RKW'.indexOf(i)]));

  function apply(x: number, y: number, pointer = p.pointer) {
    if (hotTool) { p.onChange({ pointer, hotSpot: { x, y } }); return; }
    if (pointer[y][x] !== ink) p.onChange({ pointer: paint(pointer, x, y, ink), hotSpot: p.hotSpot });
  }
  /** The cell under the pointer, from the grid's box: a captured pointer's events all land on the grid. */
  function cellOf(e: PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * POINTER_SIZE);
    const y = Math.floor(((e.clientY - r.top) / r.height) * POINTER_SIZE);
    return x >= 0 && y >= 0 && x < POINTER_SIZE && y < POINTER_SIZE ? { x, y } : null;
  }
  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const c = cellOf(e);
    if (c) { setAt(c); apply(c.x, c.y); }
  }
  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (hotTool || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    const c = cellOf(e);
    if (c) apply(c.x, c.y);
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === ' ') { e.preventDefault(); apply(at.x, at.y); return; }
    const s = step[e.key];
    if (!s) return;
    e.preventDefault();
    const next = { x: Math.min(POINTER_SIZE - 1, Math.max(0, at.x + s[0])), y: Math.min(POINTER_SIZE - 1, Math.max(0, at.y + s[1])) };
    setAt(next);
    grid.current?.querySelector<HTMLElement>(`[data-testid="pointer-cell-${next.x}-${next.y}"]`)?.focus();
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div ref={grid} role="grid" aria-label="Pointer image" data-testid="pointer-grid" onPointerDown={onDown} onPointerMove={onMove} onKeyDown={onKey}
           className="grid w-full max-w-[272px] touch-none select-none gap-px sm:w-[240px]"
           style={{ gridTemplateColumns: `repeat(${POINTER_SIZE}, 1fr)`, background: 'var(--line)', padding: 1 }}>
        {p.pointer.map((row, y) => (
          <div key={y} role="row" className="contents">
            {[...row].map((c, x) => {
              const hot = p.hotSpot.x === x && p.hotSpot.y === y;
              return (
                <div key={x} role="gridcell" tabIndex={at.x === x && at.y === y ? 0 : -1} data-testid={`pointer-cell-${x}-${y}`} data-ink={c}
                     data-hot={hot ? '' : undefined} aria-label={`Row ${y + 1}, column ${x + 1}: ${WORD[c as Ink]}${hot ? ', hot spot' : ''}`}
                     onFocus={() => setAt({ x, y })} className="aspect-square focus-visible:outline-2 focus-visible:outline-(--ring)"
                     style={{ background: look(c as Ink), boxShadow: hot ? 'inset 0 0 0 2px var(--ring)' : undefined }} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex min-w-[150px] flex-col gap-2 text-[13px]">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Pointer ink">
          {INKS.map((o) => (
            <button key={o.id} type="button" aria-pressed={!hotTool && ink === o.ink} data-testid={`pointer-ink-${o.id}`} aria-label={o.label} title={o.label}
                    onClick={() => { setInk(o.ink); setHotTool(false); }} className="size-8 rounded-md border aria-pressed:outline-2 aria-pressed:outline-offset-1 aria-pressed:outline-(--ring)"
                    style={{ background: look(o.ink), borderColor: 'var(--hairline)' }} />
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" aria-pressed={hotTool} data-testid="pointer-hotspot" onClick={() => setHotTool(!hotTool)}
                className="aria-pressed:outline-2 aria-pressed:outline-(--ring)">Set hot spot</Button>
        <div data-testid="pointer-hotspot-at" style={{ color: 'var(--faint)' }}>Hot spot: X {p.hotSpot.x}, Y {p.hotSpot.y}</div>
        <div className="flex gap-1.5">
          <Button type="button" size="sm" variant="outline" data-testid="pointer-clear"
                  onClick={() => p.onChange({ pointer: Array.from({ length: POINTER_SIZE }, () => '.'.repeat(POINTER_SIZE)), hotSpot: p.hotSpot })}>Clear</Button>
          <Button type="button" size="sm" variant="outline" data-testid="pointer-reset"
                  onClick={() => { const d = sysconfDefaults(); p.onChange({ pointer: d.pointer, hotSpot: d.hotSpot }); }}>Reset</Button>
        </div>
      </div>
    </div>
  );
}
