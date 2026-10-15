# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY cli/package.json ./cli/
RUN pnpm install --frozen-lockfile
COPY . .
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA WEBADF_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
# src/lib/auth.ts calls getDb() at import, and `next build` imports every route to collect its config, so the
# build needs SOME DATABASE_URL. This one is build-only (not an ENV, so it is not in the image) and points at a
# closed port: the pool is lazy and never connects; a page that queried at build time would fail loudly here.
RUN DATABASE_URL=postgresql://build:unused@127.0.0.1:1/unused pnpm exec next build && node docker/build-ctl.mjs

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/stefanskotte/webadf" \
      org.opencontainers.image.description="webadf self-hosted: Amiga ADF disk manager (web app, setup and scheduler)" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/.next/static ./.next/static
COPY --from=build /src/public ./public
COPY --from=build /src/drizzle ./drizzle
COPY --from=build /src/docker/dist/ctl.mjs ./ctl.mjs
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["node", "/app/ctl.mjs"]
CMD ["start"]
