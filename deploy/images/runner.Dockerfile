FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/client-sdk/package.json packages/client-sdk/package.json
COPY packages/runner-core/package.json packages/runner-core/package.json
RUN npm ci --ignore-scripts --include-workspace-root=false --workspace @maestrly/protocol --workspace @maestrly/client-sdk --workspace @maestrly/runner-core --workspace @maestrly/runner
COPY packages packages
COPY apps/runner apps/runner
RUN npm run build:protocol && npm run build:sdk && npm run build --workspace @maestrly/runner-core && npm run build:runner

FROM node:22.22.0-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/runner ./apps/runner
COPY package.json ./package.json
USER node
ENTRYPOINT ["node", "apps/runner/dist/cli.js"]
CMD ["run"]
