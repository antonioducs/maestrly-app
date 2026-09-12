FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/client-sdk/package.json packages/client-sdk/package.json
COPY packages/runner-core/package.json packages/runner-core/package.json
RUN npm ci --ignore-scripts --include-workspace-root=false --workspace @maestrly/protocol --workspace @maestrly/server
COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN npm run build:protocol && npm run build:server

FROM node:22.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol ./packages/protocol
COPY --from=build /app/apps/server ./apps/server
COPY package.json ./package.json
USER node
EXPOSE 4310
CMD ["node", "apps/server/dist/main.js"]
