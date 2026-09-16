#!/usr/bin/env node
// Vertical proof of the live-desktop dependencies. Without flags it only describes what it
// would check and contacts nothing. With --local-container it builds a disposable Ubuntu
// 24.04 arm64 image (network during the build only), runs it WITHOUT a network interface,
// shares the existing Xvfb through the pinned read-only scraping server and measures a
// real RFB client, hostile RFB input, XTEST human input and latency. No SSH, no Host VM.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
/** Exact Ubuntu noble arm64 versions verified for this phase; the build fails on drift. */
export const DESKTOP_PACKAGES = {
  'tigervnc-scraping-server': '1.13.1+dfsg-2build2',
  xvfb: '2:21.1.12-1ubuntu1.6',
  openbox: '3.6.1-12build5',
  xdotool: '1:3.20160805.1-5build1',
  scrot: '1.10-1build2',
  'x11-utils': '7.7+6build2',
  xterm: '390-1ubuntu3',
}
export const PROBE_EXTRAS = ['xauth', 'x11-xserver-utils', 'iproute2', 'ca-certificates']
export function dockerfile(packages = DESKTOP_PACKAGES) {
  const pinned = Object.entries(packages).map(([name, version]) => `${name}=${version}`).join(' ')
  return `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ${pinned} ${PROBE_EXTRAS.join(' ')} && rm -rf /var/lib/apt/lists/*
RUN dpkg-query -W ${Object.keys(packages).join(' ')} > /versions.txt
`
}
export const CONTAINER_SCRIPT = `set -eu
export DISPLAY=:10 LANG=C.UTF-8
umask 077
touch /tmp/xa
xauth -f /tmp/xa add :10 MIT-MAGIC-COOKIE-1 "$(mcookie)"
export XAUTHORITY=/tmp/xa
Xvfb :10 -screen 0 1280x800x24 -nolisten tcp -auth /tmp/xa >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
openbox >/dev/null 2>&1 &
: > /tmp/typed.txt
xterm -u8 -geometry 80x10+0+0 -e sh -c 'stty -echo; cat > /tmp/typed.txt' >/dev/null 2>&1 &
sleep 1.5
cat /versions.txt >&2
/opt/node /probe/desktop-linux-probe.mjs
`
export function usage() {
  return 'Usage: verify-bot-desktop.mjs [--local-container|--local-vm]\n  (no flags) describe the checks without contacting anything\n  --local-container  run the disposable Ubuntu container proof (Docker required; no SSH, no Host VM)\n  --local-vm         install MAESTRLY_BOT_DESKTOP_BUNDLE in a disposable NIC-less VM and drive the supervisor (no SSH, no Host VM)'
}
export async function verifyDesktop({ output } = {}) {
  const config = JSON.parse(await readFile(join(root, 'dist/bot-inputs-20260913/build-config.json'), 'utf8').catch(() => '{}'))
  const node = join(root, 'dist/bot-inputs-20260913/inputs/runtime/bin/node')
  if (config.nodeVersion !== '22.15.0') throw Error('LINUX_NODE_INPUT_REQUIRED: pinned Linux arm64 Node 22 from the bot build inputs')
  const work = output ?? (await mkdtemp(join(root, '.host-lab/desktop-proof-')))
  await mkdir(work, { recursive: true })
  const { build } = await import('esbuild')
  await build({
    entryPoints: [join(root, 'scripts/test/desktop-linux-probe.ts'), join(root, 'scripts/test/desktop-wm-probe.ts')],
    outdir: work,
    outExtension: { '.js': '.mjs' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
    alias: { '@maestrly/host-protocol': join(root, 'packages/host-protocol/src/index.ts') },
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  })
  const recipe = dockerfile()
  const tag = `maestrly-desktop-proof:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`
  await writeFile(join(work, 'Dockerfile'), recipe)
  execFileSync('docker', ['build', '--platform', 'linux/arm64', '-t', tag, work], { stdio: ['ignore', 'ignore', 'inherit'] })
  const run = spawnSync('docker', ['run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/run',
    '-v', `${node}:/opt/node:ro`, '-v', `${work}:/probe:ro`, tag, '/bin/sh', '-c', CONTAINER_SCRIPT], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const line = run.stdout.trim().split('\n').at(-1) ?? '{}'
  const report = { ...JSON.parse(line), image: tag, installed: run.stderr.split('\n').filter((l) => /\t/.test(l)), measuredAt: new Date().toISOString(), scope: 'Disposable container proof; systemd, cgroups, QEMU lane and Host transport are validated separately' }
  // Window controls through XTEST, with Openbox running the deployed configuration unchanged.
  const windowScript = `set -eu
export DISPLAY=:10 LANG=C.UTF-8 HOME=/tmp
umask 077
touch /tmp/xa
xauth -f /tmp/xa add :10 MIT-MAGIC-COOKIE-1 "$(mcookie)"
export XAUTHORITY=/tmp/xa
Xvfb :10 -screen 0 1280x800x24 -nolisten tcp -auth /tmp/xa >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
mkdir /tmp/.config /tmp/.config/openbox
cp /config/openbox-menu.xml /tmp/.config/openbox/menu.xml
openbox --config-file /config/openbox-rc.xml >/tmp/openbox.log 2>&1 &
sleep 1
/opt/node /probe/desktop-wm-probe.mjs
`
  const windows = spawnSync('docker', ['run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/run',
    '-v', `${node}:/opt/node:ro`, '-v', `${work}:/probe:ro`, '-v', `${join(root, 'deploy/bot-runtime/linux')}:/config:ro`, tag, '/bin/sh', '-c', windowScript], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  report.windowControls = JSON.parse(windows.stdout.trim().split('\n').at(-1) || '{"verified":false}')
  report.verified = report.verified === true && report.windowControls.verified === true
  await writeFile(join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return { work, report }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2)
  if (flags.length > 1 || flags.some((flag) => !['--local-container', '--local-vm'].includes(flag))) {
    process.stderr.write(`${usage()}\n`)
    process.exitCode = 1
  } else if (!flags.length) {
    process.stdout.write(`${JSON.stringify({ status: 'diagnostic', contacted: [], checks: ['pinned read-only scraping server', 'Unix socket 0600, no TCP listener', 'real RFB framebuffer and pixel change', 'hostile RFB key/pointer/clipboard/resize ignored', 'XTEST human input with accents', 'input-to-pixel p50/p95 and updates per second', 'local VM: supervisor takeover, lease expiry, restart revocation, fresh capture and resume with two bots'], packages: DESKTOP_PACKAGES, run: 'node scripts/verify-bot-desktop.mjs --local-container', vm: 'MAESTRLY_BOT_DESKTOP_BUNDLE=<versioned runtime tar> node scripts/verify-bot-desktop.mjs --local-vm' }, null, 2)}\n`)
  } else if (flags[0] === '--local-vm') {
    const { verifyBotDesktopVm } = await import('./verify-bot-desktop-vm.mjs')
    // Optional in-place upgrade: sessions are created by the previous bundle, then updated.
    const { work, report } = await verifyBotDesktopVm({ root, bundlePath: process.env.MAESTRLY_BOT_DESKTOP_BUNDLE, upgradeFrom: process.env.MAESTRLY_BOT_DESKTOP_UPGRADE_FROM || undefined })
    process.stdout.write(`${JSON.stringify({ ...report, evidence: work }, null, 2)}\n`)
    process.exitCode = report.verified === true ? 0 : 2
  } else {
    const { work, report } = await verifyDesktop()
    process.stdout.write(`${JSON.stringify({ ...report, evidence: work }, null, 2)}\n`)
    process.exitCode = report.verified === true ? 0 : 2
  }
}
