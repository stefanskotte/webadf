import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { NextConfig } from "next";
import { resolveCommit } from "./src/lib/about/build-info";

// About this server's build facts (Settings), fixed now so the running server reports its
// own build (spec 2026-10-15-about-page D7: no Vercel-only source without a
// fallback -- a Docker build passes GIT_SHA).
const WEBADF_COMMIT = resolveCommit(process.env, () =>
  execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString());
const WEBADF_NEXT_VERSION = (JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("next/package.json"), "utf8"),
) as { version: string }).version;

const nextConfig: NextConfig = {
  // The dev server's Next.js indicator sits bottom-left, over the phone tab bar's first tab, and intercepts taps on
  // it in e2e. Dev-only (production never has it); schema checked in node_modules/next/dist/server/config-schema.js.
  devIndicators: false,
  env: {
    WEBADF_COMMIT,
    WEBADF_BUILT_AT: new Date().toISOString(),
    WEBADF_NEXT_VERSION,
  },
  // /about became Settings' About this server section (C7 spec §10.3, Ruling 22). A config redirect runs before the
  // filesystem and before Proxy, so a bookmark, the Help topic's link and a signed-out visit all work (the signed-out
  // one then goes on to /sign-in, like any Settings visit). 307, not 308: browsers cache a 308 for good.
  async redirects() {
    return [{ source: '/about', destination: '/settings#about', permanent: false }];
  },
  // A share link's landing page (library sharing spec §3.4) has the claim code in its path: no Referer may carry it
  // to another site, and no cache may keep it.
  async headers() {
    return [{
      source: '/s/:path*',
      headers: [
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' },
      ],
    }];
  },
  // Self-hosting P2: the Docker build sets WEBADF_STANDALONE=1; Vercel's build never does.
  ...(process.env.WEBADF_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  // PATCH /api/devices/[id]/display validates a layout with the board's own C
  // validator, public/display.wasm, read from disk at runtime. A server
  // function bundle does not carry public/ (that is served by the CDN), so
  // name the file in this route's trace. Today's build also traces the
  // static path.join(process.cwd(), 'public', 'display.wasm') on its own
  // (checked 2026-10-05: the route's .nft.json lists it with or without this
  // entry); this keeps it there if that read ever stops being statically
  // analysable. Keys are picomatch route globs, hence the escaped brackets
  // (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md).
  outputFileTracingIncludes: {
    "/api/devices/\\[id\\]/display": ["./public/display.wasm"],
  },
};

export default nextConfig;
