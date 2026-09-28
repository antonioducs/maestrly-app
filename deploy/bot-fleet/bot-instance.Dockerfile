FROM node:22.22.0-bookworm-slim AS build
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/runner/package.json apps/runner/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/bot-gateway/package.json apps/bot-gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/client-sdk/package.json packages/client-sdk/package.json
COPY packages/runner-core/package.json packages/runner-core/package.json
COPY packages/bot-fleet-protocol/package.json packages/bot-fleet-protocol/package.json
COPY scripts scripts
RUN npm ci --include-workspace-root=false --workspace @maestrly/desktop --workspace @maestrly/runner-core --workspace @maestrly/client-sdk --workspace @maestrly/protocol --workspace @maestrly/bot-fleet-protocol
COPY apps/desktop apps/desktop
COPY packages packages
COPY config config
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN npm run build:desktop
# Docker names x86_64 "amd64"; the runtime fetchers use Node's "x64".
RUN case "${TARGETARCH}" in \
      amd64) target=linux-x64 ;; \
      arm64) target=linux-arm64 ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    node scripts/fetch-codex-runtime.mjs --target "$target" && \
    node scripts/fetch-github-copilot-runtime.mjs --target "$target" && \
    node scripts/fetch-cursor-sdk-platform.mjs --target "$target" && \
    node scripts/fetch-tunnel-client.mjs --target "$target"

FROM debian:bookworm-slim AS tools
ARG TARGETARCH
ARG UV_VERSION=0.12.15
ARG MISE_VERSION=2026.9.10
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH}" in \
      arm64) uv_target=aarch64-unknown-linux-gnu; uv_sha=0e9a3499b0587d449c9ff684c0160da607826e4af1cee220bc87f378702d3e08; mise_arch=arm64; mise_sha=1b46a14314c18f9bbce4bf6f88cc1fb3b31be8dd2b23327a851555f4e144fc61 ;; \
      amd64) uv_target=x86_64-unknown-linux-gnu; uv_sha=f97935763c04be3e692460a7aaeaaab8fc3b78fcf8b389da820b38ae7423a638; mise_arch=x64; mise_sha=f917e52216924ef0a8b4eca3f7004dfcff3b94665716ac5685fd53006a491eee ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_target}.tar.gz"; \
    echo "${uv_sha}  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /tmp; \
    install -m 0755 "/tmp/uv-${uv_target}/uv" "/tmp/uv-${uv_target}/uvx" /usr/local/bin/; \
    curl -fsSLo /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${mise_arch}"; \
    echo "${mise_sha}  /usr/local/bin/mise" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/mise

FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Etc/UTC HOME=/home/bot DISPLAY=:0 XDG_CURRENT_DESKTOP=Openbox
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium curl dbus-x11 fontconfig fonts-dejavu-core fonts-noto-color-emoji \
    fonts-noto-cjk gnome-keyring libsecret-1-0 locales openbox tint2 x11vnc xvfb x11-utils \
    xdotool xdg-utils xauth tini imagemagick libasound2 libatk-bridge2.0-0 libgtk-3-0 \
    libnss3 libgbm1 libdrm2 libxss1 libxtst6 libxkbcommon0 libatspi2.0-0 \
    && sed -i 's/^# *\(pt_BR.UTF-8 UTF-8\)/\1/' /etc/locale.gen && locale-gen \
    && install -d -m 1777 /tmp/.X11-unix \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client build-essential python3-venv python3-pip python-is-python3 \
    ripgrep jq fd-find zip unzip sqlite3 less procps file xz-utils iptables iproute2 util-linux \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/include/node /usr/local/include/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=build /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
COPY --from=tools /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/mise /usr/local/bin/
COPY deploy/bot-fleet/maestrly-toolchain.sh /etc/profile.d/maestrly-toolchain.sh
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && corepack enable --install-directory /usr/local/bin pnpm yarn \
    && chmod 0644 /etc/profile.d/maestrly-toolchain.sh
ENV PATH=/home/bot/.local/bin:/home/bot/.local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/home/bot/.local \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS=node
COPY --from=build /app/node_modules /opt/maestrly/node_modules
COPY --from=build /app/apps/desktop/out /opt/maestrly/apps/desktop/out
COPY --from=build /app/apps/desktop/package.json /opt/maestrly/apps/desktop/package.json
COPY --from=build /app/apps/desktop/resources /opt/maestrly/apps/desktop/resources
COPY --from=build /app/packages /opt/maestrly/packages
COPY --from=build /app/config /opt/maestrly/config
COPY deploy/bot-fleet/openbox-rc.xml /opt/maestrly/openbox-rc.xml
COPY deploy/bot-fleet/openbox-environment-rc.xml /opt/maestrly/openbox-environment-rc.xml
COPY deploy/bot-fleet/tint2rc /opt/maestrly/tint2rc
COPY deploy/bot-fleet/bot-entrypoint.sh /usr/local/bin/bot-entrypoint
COPY deploy/bot-fleet/egress-guard.sh /usr/local/bin/maestrly-egress-guard
COPY deploy/bot-fleet/prepare-xvfb-display.sh /usr/local/bin/prepare-xvfb-display
COPY deploy/bot-fleet/maestrly-bot-browser /usr/local/bin/maestrly-bot-browser
RUN useradd -m -u 1000 -s /bin/bash bot && chmod 755 /usr/local/bin/bot-entrypoint && \
    chmod 0755 /usr/local/bin/maestrly-egress-guard && \
    chmod 755 /usr/local/bin/prepare-xvfb-display && \
    chmod 0755 /usr/local/bin/maestrly-bot-browser && \
    mkdir -p /home/bot/.config/tint2 && chown -R bot:bot /home/bot && \
    chmod 4755 /opt/maestrly/node_modules/electron/dist/chrome-sandbox
USER bot
WORKDIR /opt/maestrly
VOLUME /home/bot
EXPOSE 7680 5900 5901
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/bot-entrypoint"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=90s CMD curl -fsS -H "Authorization: Bearer ${MAESTRLY_BOT_CONTROL_TOKEN}" -H 'X-Maestrly-Fleet-Protocol: 1' http://127.0.0.1:${MAESTRLY_BOT_CONTROL_PORT:-7680}/v1/health >/dev/null || exit 1
