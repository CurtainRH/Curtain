# Curtain operator (and keeper) image. Build context is backend/ (the Bun workspace root).
#   docker build -t curtain-operator .                              -> operator (default)
#   docker run ... curtain-operator bun run --cwd services/keeper start  -> keeper
FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY services/operator/package.json services/operator/
COPY services/keeper/package.json services/keeper/
COPY services/multiplier-view/package.json services/multiplier-view/
RUN bun install --frozen-lockfile --production

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY db ./db
COPY packages ./packages
COPY services/operator ./services/operator
COPY services/keeper ./services/keeper
EXPOSE 3100
USER bun
CMD ["bun", "run", "--cwd", "services/operator", "start"]
