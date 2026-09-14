export type LinkSource = 'confirmed' | 'automatic';

export function effectiveLink(
  game: { demozooProductionId: number | null; demozooLinkSource: string | null },
  automaticIds: number[],
  dismissed: ReadonlySet<number>,
): { productionId: number; source: LinkSource } | null {
  if (game.demozooProductionId !== null && game.demozooLinkSource === 'confirmed') {
    return { productionId: game.demozooProductionId, source: 'confirmed' };
  }
  const ids = [...new Set(automaticIds)].filter((id) => !dismissed.has(id));
  return ids.length === 1 ? { productionId: ids[0], source: 'automatic' } : null;
}

/**
 * Unlink step (ii), R11: once any confirmation is cleared, what -- if
 * anything -- must now be dismissed so the automatic link doesn't silently
 * reassert the link Unlink just removed (and the title it wrote). null
 * means nothing to hide: no automatic link agrees (including because the
 * game's disks disagree -- see effectiveLink), or it is already dismissed.
 */
export function productionToDismissAfterClear(
  automaticIds: number[],
  dismissed: ReadonlySet<number>,
): number | null {
  const link = effectiveLink({ demozooProductionId: null, demozooLinkSource: null }, automaticIds, dismissed);
  return link ? link.productionId : null;
}

/**
 * applyAutomaticLink's per-game guard, R11: would `productionId` actually be
 * this game's effective automatic link, given EVERY disk it holds (not just
 * the one disk whose blob triggered the sweep) and what it has already
 * dismissed? False on disagreement between disks -- effectiveLink shows
 * nothing rather than guess, so writing a title here would go stale the
 * moment it was written, with no automatic path back (see rederive.ts /
 * unlinkDemozoo).
 */
export function agreesOnAutomaticLink(
  automaticIds: number[],
  dismissed: ReadonlySet<number>,
  productionId: number,
): boolean {
  return effectiveLink({ demozooProductionId: null, demozooLinkSource: null }, automaticIds, dismissed)
    ?.productionId === productionId;
}
