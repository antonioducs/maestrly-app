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
RUN npm ci --ignore-scripts --include-workspace-root=false --workspace @maestrly/protocol --workspace @maestrly/client-sdk --workspace @maestrly/web
COPY packages/protocol packages/protocol
COPY packages/client-sdk packages/client-sdk
COPY apps/web apps/web
RUN npm run build:protocol && npm run build:sdk && npm run build:web

FROM nginx:1.29.1-alpine@sha256:42a516af16b852e33b7682d5ef8acbd5d13fe08fecadc7ed98605ba5e3b26ab8
COPY deploy/images/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
