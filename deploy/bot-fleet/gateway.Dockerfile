FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/bot-gateway/package.json apps/bot-gateway/package.json
COPY packages/bot-fleet-protocol/package.json packages/bot-fleet-protocol/package.json
RUN npm ci --ignore-scripts --include-workspace-root=false --workspace @maestrly/bot-fleet-protocol --workspace @maestrly/bot-gateway
COPY packages/bot-fleet-protocol packages/bot-fleet-protocol
COPY apps/bot-gateway apps/bot-gateway
RUN npm run build:fleet-protocol && npm run build:bot-gateway

FROM node:22.22.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/bot-gateway/package.json apps/bot-gateway/package.json
COPY packages/bot-fleet-protocol/package.json packages/bot-fleet-protocol/package.json
RUN npm ci --omit=dev --ignore-scripts --include-workspace-root=false --workspace @maestrly/bot-fleet-protocol --workspace @maestrly/bot-gateway

FROM node:22.22.0-bookworm-slim
ARG MAESTRLY_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends gosu curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production MAESTRLY_GATEWAY_DATA_DIR=/data
ENV MAESTRLY_GATEWAY_VERSION=$MAESTRLY_VERSION
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/bot-gateway/package.json apps/bot-gateway/package.json
COPY --from=dependencies /app/packages/bot-fleet-protocol/package.json packages/bot-fleet-protocol/package.json
COPY --from=build /app/apps/bot-gateway/dist apps/bot-gateway/dist
COPY --from=build /app/packages/bot-fleet-protocol/dist packages/bot-fleet-protocol/dist
COPY deploy/bot-fleet/gateway-entrypoint.sh /usr/local/bin/gateway-entrypoint
COPY deploy/bot-fleet/seccomp-bot.json /etc/maestrly-bot/seccomp-bot.json
RUN chmod 755 /usr/local/bin/gateway-entrypoint && mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 7443 7444
ENTRYPOINT ["/usr/local/bin/gateway-entrypoint"]
CMD ["node", "apps/bot-gateway/dist/main.js", "serve"]
