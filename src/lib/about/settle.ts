/** One About section's loader, so a failure blanks only that section (spec "Errors"). */
export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    console.error('about: section failed', e);
    return { ok: false };
  }
}
