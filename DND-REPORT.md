# DnD move e2e failure (disk-drag-drop.spec.ts "a move by drag...")

Cause: TEST bug (fragile geometry), not product.
Evidence: instrumented onDragStart/Move/End. The drag activated (start block 3) but onDragEnd had over=null and no
PATCH was sent. Every onDragMove showed delta.y drifting away from the expected -32: dnd-kit auto-scrolled the window
because the grip sat at y=583 in a 720px viewport (inside the ~20% bottom auto-scroll zone), so the TARGET row scrolled
out from under the pointer. Hit-testing of grip/target before the drag was correct (elementFromPoint), so no overlay
or unhandled dialog was involved. The tree now sits lower on the page than when the spec was written (page header
growth; 2d19d93 touched page-header.tsx), which pushed the pair into the auto-scroll zone. A real user simply scrolls.
Fix: dragOnto() scrolls the drop target to mid-viewport before dragging (e2e/disk-drag-drop.spec.ts).
Result: whole spec 6/6 pass (PORT=3100).
Concerns: other specs using a similar dragOnto (collections.spec.ts) could hit the same issue if their layouts sit low.
