import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
