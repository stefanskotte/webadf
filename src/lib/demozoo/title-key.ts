/**
 * The spike's normaliser (HANDOFF, Demozoo spike). Exact equality of keys is
 * the only title comparison anywhere in the Demozoo code: no fuzzy distance.
 * Non-ASCII letters are dropped, deliberately matching what was measured.
 */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');
}
