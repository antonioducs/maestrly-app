import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONTAINER_SCRIPT, DESKTOP_PACKAGES, dockerfile } from '../verify-bot-desktop.mjs'

const script = fileURLToPath(new URL('../verify-bot-desktop.mjs', import.meta.url))
test('without flags the desktop proof only describes itself and contacts nothing', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } })
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'diagnostic')
  assert.deepEqual(report.contacted, [])
})
test('unknown flags are refused and no target can be named', () => {
  for (const flag of ['--ssh=mini', '--vm', '--allow-guest-preparation']) {
    const result = spawnSync(process.execPath, [script, flag], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage/)
  }
})
test('the local VM proof is NIC-less, adds only the desktop port and needs an explicit bundle', () => {
  const vm = readFileSync(new URL('../verify-bot-desktop-vm.mjs', import.meta.url), 'utf8')
  assert.match(vm, /'-nic', 'none'/)
  assert.match(vm, /'desktop', 'org\.maestrly\.bot\.desktop\.0'/)
  assert.doesNotMatch(vm, /\bssh\b|maestrly-host-lab|netdev|virtio-net/)
  assert.match(vm, /BUNDLE_REQUIRED/)
  const result = spawnSync(process.execPath, [script, '--local-vm', '--local-container'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
})
test('the container proof pins versions, runs without a network and never exposes VNC over TCP', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /'--network', 'none'/)
  assert.doesNotMatch(source, /-p\s|--publish|5900|--network', 'host/)
  for (const [name, version] of Object.entries(DESKTOP_PACKAGES)) assert.ok(dockerfile().includes(`${name}=${version}`))
  assert.match(CONTAINER_SCRIPT, /-nolisten tcp/)
  assert.match(CONTAINER_SCRIPT, /-auth \/tmp\/xa/)
  const probe = readFileSync(new URL('./desktop-linux-probe.ts', import.meta.url), 'utf8')
  for (const check of ['tcpListeners', 'pointerUnchanged', 'clipboardOwner', 'inputToPixelMs', 'updatesPerSecond', 'transmitterStoppedAfterLastViewer']) assert.ok(probe.includes(check))
  // Window controls run against the deployed Openbox configuration, read-only and unmodified.
  assert.match(source, /deploy\/bot-runtime\/linux'\)\}:\/config:ro/)
  assert.match(source, /openbox --config-file \/config\/openbox-rc\.xml/)
  assert.match(source, /report\.windowControls\.verified === true/)
  const windows = readFileSync(new URL('./desktop-wm-probe.ts', import.meta.url), 'utf8')
  for (const check of ['focusClick', 'move', 'maximizeWidth', 'restoredWidth', 'closed', 'HumanInput']) assert.ok(windows.includes(check), check)
})
