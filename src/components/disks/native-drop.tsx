'use client';

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

/**
 * Lets the Browse tree hand an OS file drop to the staging area, with the
 * folder it landed on as the destination.
 *
 * HANDOFF 3v recorded folder rows as NOT native drop targets, on the grounds
 * that nothing in a drop handler says which row the pointer was over. That
 * holds for dnd-kit's own drags (pointer events, no `drop` event at all), but
 * an OS file drag fires a real `drop` on the element under the pointer -- so
 * each row can simply listen for it. The two never meet: dnd-kit moves
 * entries already on the disk, this takes files from outside it.
 *
 * Staging stays the one place a drop becomes a write: the tree only forwards
 * the DataTransfer and a destination block, and `DropStaging` registers the
 * receiver that reads it.
 */
export type NativeDropReceiver = (items: DataTransferItemList, destinationBlock: number) => void;

interface NativeDropValue {
  register(receiver: NativeDropReceiver | null): void;
  /** False until a staging area has registered, so the tree can leave drops alone. */
  available(): boolean;
  /** Reactive twin of `available()`: true once a staging area has registered. The tree shows it as `data-native-drop`. */
  ready: boolean;
  receive: NativeDropReceiver;
}

const NativeDropContext = createContext<NativeDropValue | null>(null);

export function NativeDropProvider({ children }: { children: ReactNode }) {
  const ref = useRef<NativeDropReceiver | null>(null);
  const [ready, setReady] = useState(false);
  const value = useMemo<NativeDropValue>(() => ({
    register(receiver) { ref.current = receiver; setReady(receiver !== null); },
    available() { return ref.current !== null; },
    ready,
    receive(items, block) {
      // The receiver registers in an effect, a moment after the tree itself is interactive. A drop in that moment
      // cannot be held back (the browser neuters the DataTransfer when the handler returns), so say so rather than
      // do nothing.
      if (!ref.current) { toast.error('Not ready yet', { description: 'The page is still loading. Drop the files again in a moment.' }); return; }
      ref.current(items, block);
    },
  }), [ready]);
  return <NativeDropContext.Provider value={value}>{children}</NativeDropContext.Provider>;
}

export function useNativeDrop(): NativeDropValue | null {
  return useContext(NativeDropContext);
}

/** An OS file drag, as opposed to dragging text, a link, or nothing native at all. */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes('Files');
}
