# syntax=docker/dockerfile:1
ARG NODE_VERSION=26

# ---- deps: full toolchain so native modules (better-sqlite3, argon2) build or fetch prebuilds
FROM node:${NODE_VERSION}-trixie AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund --foreground-scripts

# ---- build
FROM node:${NODE_VERSION}-trixie AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# public/ can arrive missing (git, and so an app store, drops empty folders); the runtime copies it.
RUN mkdir -p public && npm run build
# The trace keeps every platform's native binaries, and copies source and test fixtures it finds
# behind paths built from DATA_DIR and CADDY_DIR. The server needs neither: routes run from .next.
RUN arch="$(node -p process.arch)" \
  && find .next/standalone/node_modules/better-sqlite3/prebuilds -type f ! -name "linux-${arch}.node" -delete \
  && rm -rf .next/standalone/node_modules/@img/sharp-wasm32 .next/standalone/node_modules/@emnapi \
  && find .next/standalone -mindepth 1 -maxdepth 1 ! -name .next ! -name node_modules ! -name server.js ! -name package.json -exec rm -rf {} +

# ---- runtime: slim image + the host tools Gluon drives
FROM node:${NODE_VERSION}-trixie-slim AS runtime
# npm and corepack go too: nothing installs packages at runtime, and it is less to patch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      util-linux smartmontools iproute2 procps unzip 7zip xz-utils bzip2 zstd tar libarchive-tools \
      bind9-dnsutils iputils-ping ca-certificates curl tini git \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8130 HOSTNAME=0.0.0.0 GLUON_DATA=/data
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Entry point: stamps the real TCP peer on each request (see the file), sizes the thread pool and
# bounds shutdown, then runs server.js.
COPY docker/gluon-server.cjs ./gluon-server.cjs
# The self-updater Gluon hands to the host (Settings → Updates); see the file.
COPY docker/gluon-update.sh ./gluon-update.sh
# What this build is, for Settings → Updates: the release version, the commit it was built from,
# and a build label (a store version, or "github" for builds the updater made).
ARG GLUON_VERSION=""
ARG GLUON_COMMIT=""
ARG GLUON_BUILD=""
ENV GLUON_VERSION=$GLUON_VERSION GLUON_COMMIT=$GLUON_COMMIT GLUON_BUILD=$GLUON_BUILD
# Tells net-zone that every request carries the peer stamp; a request without one is treated as
# "away" (fails closed if server.js is ever started without the wrapper).
ENV GLUON_PEER_HEADER=1
# Coolify shares the Umbrel server and its daily cleanup runs docker rmi on every image no container
# uses, unless it carries this label. Umbrel's app only builds a thin image FROM this one, so without
# the label the base is deleted and the next app start can't rebuild.
LABEL coolify.managed=true \
      org.opencontainers.image.title="Gluon" \
      org.opencontainers.image.description="A home server manager: health, apps, files, storage, network and diagnostics in one web app." \
      org.opencontainers.image.source="https://github.com/slukedev/gluon" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.version=$GLUON_VERSION \
      org.opencontainers.image.revision=$GLUON_COMMIT
EXPOSE 8130
# Runs as root on purpose: Gluon manages the host (nsenter into PID 1 for systemd, apt and mounts,
# the Docker socket, disks and SMART, files owned by any user), which needs the privileged container
# compose.yaml describes. There is no subset of that a non-root user could do.
# The healthcheck lives in the image so installs without one in compose (Umbrel) still report when
# Gluon is up; the updater rolls back a version that never gets there.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8130}/api/health`,{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
# pid: host means tini is not PID 1, so it registers as a subreaper to still collect zombies.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "gluon-server.cjs"]
