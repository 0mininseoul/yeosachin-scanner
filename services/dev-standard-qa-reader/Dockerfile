FROM node:24-bookworm-slim AS build
WORKDIR /work
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY lib ./lib
COPY config ./config
COPY scripts/dev-standard-cloud-six/identity.mjs ./scripts/dev-standard-cloud-six/identity.mjs
COPY tests/analysis/execution/fixtures ./tests/analysis/execution/fixtures
COPY services/dev-standard-qa-reader ./services/dev-standard-qa-reader
RUN node services/dev-standard-qa-reader/build.mjs /out/reader.cjs

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY services/dev-standard-qa-reader/package.json services/dev-standard-qa-reader/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
  && node -e "require('sharp');require('playwright-core')" \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/reader.cjs ./reader.cjs
USER node
CMD ["node","reader.cjs"]
