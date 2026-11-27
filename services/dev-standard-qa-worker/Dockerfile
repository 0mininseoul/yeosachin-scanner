FROM node:24-bookworm-slim AS build
WORKDIR /work
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY app ./app
COPY config ./config
COPY lib ./lib
COPY services/dev-standard-qa-worker ./services/dev-standard-qa-worker
COPY tests/analysis/execution/fixtures ./tests/analysis/execution/fixtures
COPY tests/commerce/precheckout/fixtures ./tests/commerce/precheckout/fixtures
RUN node services/dev-standard-qa-worker/build.mjs /out/worker.cjs
# Remove provider SDKs in this disposable image after the dependency install applies
# the repository patches. Ensure no production transport resolves from the worker.
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund && \
    rm -rf node_modules/@google/genai node_modules/apify-client node_modules/resend && \
    node -e "for(const m of ['@google/genai/node','apify-client','resend']){try{require.resolve(m)}catch(e){if(e.code==='MODULE_NOT_FOUND')continue;throw e}throw Error('paid provider SDK remains')}"
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /work/node_modules ./node_modules
COPY --from=build /out/worker.cjs ./worker.cjs
COPY --from=build /work/services/dev-standard-qa-worker/egress.cjs ./egress.cjs
USER node
CMD ["node","--require","./egress.cjs","worker.cjs"]
