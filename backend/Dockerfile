# Builds the @curtain/api service. Build context is backend/ (the Bun workspace root).
FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/sdk/package.json packages/sdk/
COPY packages/recipes/package.json packages/recipes/
COPY packages/verifier/package.json packages/verifier/
COPY services/api/package.json services/api/
COPY services/broadcaster/package.json services/broadcaster/
COPY services/indexer/package.json services/indexer/
COPY services/multiplier-view/package.json services/multiplier-view/
COPY services/ppoi-node/package.json services/ppoi-node/
COPY services/prover-assist/package.json services/prover-assist/
COPY services/solvency/package.json services/solvency/
COPY services/status/package.json services/status/
RUN bun install --frozen-lockfile --production

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY db ./db
COPY services/api ./services/api
WORKDIR /app/services/api
EXPOSE 3000
USER bun
CMD ["bun", "run", "start"]
