#!/usr/bin/env bash
# Runs inside the image of this directory's Dockerfile from the copy of the working tree in /work, which
# scripts/test-e2e-docker.mjs makes first. Installs, builds, and runs the desktop E2E suite under Xvfb with the given
# Playwright arguments, like the CI's Linux job, then copies Playwright's results to /results.
set -euo pipefail

cd /work
npm ci
npm run build

status=0
xvfb-run -a npm run test:e2e --workspace @maestrly/desktop -- "$@" || status=$?
if [ -d apps/desktop/test-results ]; then
  cp -R apps/desktop/test-results/. /results/ || echo 'Could not copy the results to apps/desktop/test-results.' >&2
fi
exit "$status"
