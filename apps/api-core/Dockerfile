# Build context: repository root (needs the workspace packages).
#   docker build -f apps/api-core/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/dsl-parser/package.json packages/dsl-parser/
COPY apps/api-core/package.json apps/api-core/
RUN pnpm install --frozen-lockfile --filter "@constructos/api..."
COPY packages ./packages
COPY apps/api-core ./apps/api-core
RUN pnpm --filter "@constructos/api..." build \
 && pnpm --filter @constructos/api deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/v1/health || exit 1
# Migrations run from this image too:
#   node node_modules/@constructos/db/dist/migrate.js   (as the owner role)
CMD ["node", "dist/main.js"]
