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
