# Linux environment for the desktop Electron E2E suite, like the CI's Linux job on ubuntu-latest: Ubuntu 24.04, Xvfb,
# Electron's system libraries, a native toolchain and Playwright's Chromium. The repository is not part of the image:
# `npm run test:e2e:docker` copies the working tree into every run. See docs/development.md.
FROM node:24.21.0-bookworm-slim AS node

FROM ubuntu:24.04
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Electron needs GTK and the libraries below besides Chromium's; the CI runner image already has them.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates git python3 xauth xvfb \
    libasound2t64 libatspi2.0-0t64 libgbm1 libgtk-3-0t64 libnotify4 libnss3 libsecret-1-0 libxss1 libxtst6 xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# The version in package-lock.json, so the browser matches the Playwright that runs the suite.
ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN test -n "$PLAYWRIGHT_VERSION" \
  && npx -y "playwright@$PLAYWRIGHT_VERSION" install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

# Electron refuses to run as root with its sandbox, so the suite runs as the image's ubuntu user. The cache directory
# (npm, Electron, node-gyp headers) becomes a named volume shared by runs; a new volume takes this directory's owner.
ENV LANG=C.UTF-8 \
  npm_config_cache=/home/ubuntu/.cache/npm \
  npm_config_update_notifier=false \
  npm_config_fund=false \
  npm_config_audit=false
RUN install -d -o ubuntu -g ubuntu /work /home/ubuntu/.cache
USER ubuntu
WORKDIR /work
