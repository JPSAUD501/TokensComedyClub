FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:web

FROM oven/bun:1-slim AS runner
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vite.config.ts ./vite.config.ts
COPY package.json ./

ENV NODE_ENV=production
EXPOSE 5109

CMD ["bun", "run", "preview:web"]
