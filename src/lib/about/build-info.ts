/**
 * What this server was built from (About page spec, "Web app"). The values
 * are fixed at BUILD time by next.config.ts (`env`), so a running server
 * reports its own build, not whatever checkout sits next to it.
 * resolveCommit has no imports so next.config.ts can call it.
 */
export function resolveCommit(env: Record<string, string | undefined>, git: () => string | null): string {
  for (const v of [env.VERCEL_GIT_COMMIT_SHA, env.GIT_SHA]) {
    const t = v?.trim();
    if (t) return t;
  }
  try {
    const t = git()?.trim();
    if (t) return t;
  } catch {
    // no .git (a Docker build that copied the sources only)
  }
  return 'unknown';
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export function shortCommit(commit: string): string {
  return FULL_SHA.test(commit) ? commit.slice(0, 7) : commit;
}

export function commitUrl(commit: string): string | null {
  return FULL_SHA.test(commit) ? `https://github.com/stefanskotte/webadf/commit/${commit}` : null;
}

export interface BuildInfo {
  commit: string;
  shortCommit: string;
  commitUrl: string | null;
  /** ISO 8601, or null when the build did not record one. */
  builtAt: string | null;
  nextVersion: string;
}

export function buildInfo(): BuildInfo {
  // Each read is a whole `process.env.NAME` expression: next.config `env`
  // replaces those literally at build time and cannot see a destructure.
  const commit = process.env.WEBADF_COMMIT || 'unknown';
  return {
    commit,
    shortCommit: shortCommit(commit),
    commitUrl: commitUrl(commit),
    builtAt: process.env.WEBADF_BUILT_AT || null,
    nextVersion: process.env.WEBADF_NEXT_VERSION || 'unknown',
  };
}
