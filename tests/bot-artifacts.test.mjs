import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
test('bot runtime deployment artifacts exist, parse as shell and never expose CDP, VNC or an unsandboxed browser', () => {
  for (const file of ['install.sh', 'maestrly-bot-helper.sh', 'desktop-session.sh'])
    assert.equal(spawnSync('/bin/sh', ['-n', path.join(root, 'deploy/bot-runtime/linux', file)]).status, 0, file)
  const install = read('deploy/bot-runtime/linux/install.sh')
  assert.match(install, /--bundle/)
  assert.match(install, /--sha256/)
  assert.match(install, /\/var\/lib\/maestrly\/bot-runtime/)
  assert.match(install, /installed\.json/)
  assert.match(install, /sha256sum/)
  const runtime = read('deploy/bot-runtime/linux/maestrly-bot-runtime.service')
  assert.match(runtime, /User=maestrlybot/)
  assert.match(runtime, /org\.maestrly\.bot\.control\.0/)
  assert.match(runtime, /MAESTRLY_BOT_PACKAGED=1/)
  const sources = ['apps/bot-runtime/src/tools/browser.ts', 'apps/bot-runtime/src/desktop/session.ts'].filter((f) => existsSync(path.join(root, f))).map(read).join('\n')
  assert.doesNotMatch(sources, /--no-sandbox/)
  assert.doesNotMatch(sources, /--remote-debugging-port/)
  assert.doesNotMatch(sources, /x11vnc|Xvnc|xrdp/)
  const sudoers = read('deploy/bot-runtime/linux/sudoers.d-maestrly-bot')
  assert.equal(sudoers.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).length, 0)
  assert.doesNotMatch(sudoers, /ALL=\(ALL\)/)
})
test('bot runtime bundle builder requires an explicit pinned manifest and never downloads', () => {
  const builder = read('scripts/build-bot-runtime.mjs')
  assert.match(builder, /BUILD_CONFIG_REQUIRED/)
  assert.doesNotMatch(builder, /fetch\(|https?:\/\/(?!example)/)
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-bot-runtime.mjs')], { env: { ...process.env, MAESTRLY_BOT_BUILD_CONFIG: '' }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(`${result.stdout}${result.stderr}`, /BUILD_CONFIG_REQUIRED/)
})
test('phase-one image, host runtime and bot bundle keep distinct identities and the QEMU profile stays NIC-less', () => {
  const image = read('scripts/build-host-image-qemu.mjs')
  assert.match(image, /ubuntu-24\.04-\$\{config\.releaseDate\}-arm64\.qcow2/)
  const bundle = read('scripts/build-bot-runtime.mjs')
  assert.match(bundle, /maestrly-bot-runtime-/)
  const args = read('packages/host-core/src/providers/qemu/arguments.ts')
  assert.match(args, /'-nic',\s*'none'/)
  assert.doesNotMatch(read('packages/host-core/src/guest/profile.ts'), /netdev|-nic|user,id/)
  const scripts = JSON.parse(read('package.json')).scripts
  for (const name of ['build:bot-runtime', 'build:bot:image', 'check:bot-phase2', 'test:bot-phase2', 'lab:bot:doctor', 'lab:bot:prepare', 'lab:bot:smoke'])
    assert.ok(scripts[name], `missing script ${name}`)
})
test('host protocol methods for bots are exhaustive in both the wire schema and the desktop projection', () => {
  const rpc = read('packages/host-protocol/src/bot-rpc.ts')
  const methods = [...rpc.matchAll(/request\(\s*'(bot\.[a-zA-Z.]+)'/g)].map((m) => m[1])
  assert.ok(methods.length >= 36)
  for (const method of methods) assert.match(rpc, new RegExp(`'${method.replaceAll('.', '\\.')}':`), `result schema for ${method}`)
  const desktop = read('apps/bot-desktop/src/main/host-client.ts')
  assert.match(desktop, /botResultSchemas\[method as BotMethod\]/)
})
