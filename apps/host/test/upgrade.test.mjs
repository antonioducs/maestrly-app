import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assessUpgrade, compare, collectLiveFacts, liveRpc } from '../../../deploy/host/macos/check-upgrade.mjs'
const installed = { owner: 'root', worldWritable: false, serviceVersion: '0.1.0', config: { stateDirectory: '/Library/MaestrlyHost/state', capacity: { cpus: 4, memoryMiB: 8192, diskGiB: 40 }, images: [{ id: 'img-1' }] }, reserved: { cpus: 4, memoryMiB: 4096, diskGiB: 24 }, referencedImageIds: ['img-1'] }
const candidate = { manifest: { version: 1, serviceVersion: '0.2.0' }, config: { stateDirectory: '/Library/MaestrlyHost/state', capacity: { cpus: 4, memoryMiB: 8192, diskGiB: 40 }, images: [{ id: 'img-1' }, { id: 'bot-img' }], templates: [{ id: 'bot-ready' }] }, replacesRuntime: false }
const ok = { window: true, backup: true }
test('upgrade is ready only with a window, a backup, no active bot work and preserved catalogue/quotas', () => {
  assert.deepEqual(assessUpgrade({ installed, candidate, activity: { activeSetups: 0, activeTurns: 0, runningVms: 2 }, authorization: ok }), { status: 'ready', blockers: [] })
  const blocked = (patch) => assessUpgrade({ installed, candidate, activity: { activeSetups: 0, activeTurns: 0, runningVms: 2 }, authorization: ok, ...patch }).blockers
  assert.match(blocked({ activity: { activeSetups: 1, activeTurns: 0, runningVms: 0 } }).join(), /BOT_SETUP_ACTIVE/)
  assert.match(blocked({ activity: { activeSetups: 0, activeTurns: 1, runningVms: 0 } }).join(), /BOT_TURN_ACTIVE/)
  assert.match(blocked({ candidate: { ...candidate, replacesRuntime: true } }).join(), /RUNTIME_IN_USE/)
  assert.match(blocked({ authorization: { window: false, backup: true } }).join(), /WINDOW_REQUIRED/)
  assert.match(blocked({ authorization: { window: true, backup: false } }).join(), /BACKUP_REQUIRED/)
  assert.match(blocked({ candidate: { ...candidate, manifest: { version: 1, serviceVersion: '0.0.9' } } }).join(), /PACKAGE_DOWNGRADE/)
  assert.match(blocked({ candidate: { ...candidate, config: { ...candidate.config, capacity: { cpus: 2, memoryMiB: 8192, diskGiB: 40 } } } }).join(), /QUOTA_BELOW_RESERVATION/)
  assert.match(blocked({ candidate: { ...candidate, config: { ...candidate.config, images: [{ id: 'bot-img' }] } } }).join(), /IMAGE_REFERENCED/)
  assert.match(blocked({ installed: { ...installed, owner: 'user' } }).join(), /INSTALL_UNTRUSTED/)
  assert.ok(compare('0.2.0', '0.1.9') > 0)
})
test('upgrade script never deletes the installation, backs up SQLite with WAL and keeps the previous runtime', () => {
  const script = readFileSync(new URL('../../../deploy/host/macos/upgrade.sh', import.meta.url), 'utf8')
  assert.match(script, /\.backup/)
  assert.doesNotMatch(script, /rm -rf "\$base"/)
  assert.match(script, /app\.previous-/)
  assert.doesNotMatch(script, /mv .*runtime|ditto .*runtime|writeFileSync\(installedPath/)
  assert.match(script, /--window-confirmed/)
  assert.match(script, /check-upgrade\.mjs/)
  const result = spawnSync('/bin/sh', ['-n', fileURLToPath(new URL('../../../deploy/host/macos/upgrade.sh', import.meta.url))])
  assert.equal(result.status, 0)
})

test('upgrade refuses incomplete live evidence rather than treating it as idle', () => {
  const input = { installed, candidate, activity: { activeSetups: 0, activeTurns: 0, runningVms: 0 }, authorization: ok }
  for (const activity of [null, {}, { activeSetups: 0, activeTurns: 0 }, { activeSetups: -1, activeTurns: 0, runningVms: 0 }]) {
    assert.match(assessUpgrade({ ...input, activity }).blockers.join(), /ACTIVITY_UNKNOWN/)
  }
  for (const reserved of [null, {}, { cpus: 4, memoryMiB: NaN, diskGiB: 24 }]) {
    assert.match(assessUpgrade({ ...input, installed: { ...installed, reserved } }).blockers.join(), /RESERVATIONS_UNKNOWN/)
  }
  assert.match(assessUpgrade({ ...input, installed: { ...installed, referencedImageIds: undefined } }).blockers.join(), /IMAGE_REFERENCES_UNKNOWN/)
})

const host = { protocolVersion: 1, serviceVersion: '0.1.0', capabilities: ['vm.create'], allocated: { cpus: 2, memoryMiB: 2048, diskGiB: 12 } }
const vm = { id: 'lab-mini-linux-1', imageId: 'ubuntu', state: 'running', cpus: 2, memoryMiB: 2048, diskGiB: 12 }
test('live legacy inventory supplies real reservations and images without calling bot RPC', () => {
  const calls = []
  const facts = collectLiveFacts((method, params) => {
    calls.push([method, params])
    if (method === 'host.inspect') return host
    if (method === 'vm.list') return [vm]
    throw Error('legacy bot RPC called')
  })
  assert.deepEqual(calls, [['host.inspect', {}], ['vm.list', { includeRetained: true }]])
  assert.deepEqual(facts.reserved, host.allocated)
  assert.deepEqual(facts.referencedImageIds, ['ubuntu'])
  assert.deepEqual(facts.activity, { activeSetups: 0, activeTurns: 0, runningVms: 1 })
})
test('bot-capable inventory inspects setup and turn statuses, including waiting work', () => {
  for (const terminal of [false, true]) {
    const calls = []
    const facts = collectLiveFacts((method, params) => {
      calls.push(method)
      if (method === 'host.inspect') return { ...host, capabilities: ['bot.runtime.v1'] }
      if (method === 'vm.list') return [{ ...vm, state: 'stopped' }]
      if (method === 'bot.list') { assert.deepEqual(params, { includeArchived: true }); return [{ id: 'b', status: 'ready', setupOperationId: 's', activeTurnId: 't' }] }
      if (method === 'bot.setup.inspect') { assert.deepEqual(params, { operationId: 's' }); return { id: 's', botId: 'b', status: terminal ? 'succeeded' : 'waiting_user' } }
      if (method === 'bot.turn.get') return { id: 't', botId: 'b', status: terminal ? 'interrupted' : 'waiting_approval' }
      throw Error(method)
    })
    assert.equal(facts.activity.activeSetups, terminal ? 0 : 1)
    assert.equal(facts.activity.activeTurns, terminal ? 0 : 1)
    assert.equal(calls.length, 5)
  }
})
test('collection fails closed on unavailable or malformed live facts', () => {
  for (const bad of [null, {}, { ...host, allocated: {} }, { ...host, capabilities: ['bot.unknown'] }]) {
    assert.throws(() => collectLiveFacts(method => method === 'host.inspect' ? bad : []), /LIVE_EVIDENCE_INVALID/)
  }
  for (const bad of [null, {}, [{ ...vm, state: 'new-state' }], [{ ...vm, cpus: -1 }], [vm, vm]]) {
    assert.throws(() => collectLiveFacts(method => method === 'host.inspect' ? host : bad), /LIVE_EVIDENCE_INVALID/)
  }
  assert.throws(() => collectLiveFacts(() => { throw Error('timeout') }), /timeout/)
})
test('fixed RPC transport validates envelopes and bounds process time and output', () => {
  const run = (value, patch = {}) => (command, args, options) => {
    assert.equal(command, '/Library/MaestrlyHost/bin/maestrly-host')
    assert.deepEqual(args, ['rpc-stdio'])
    assert.equal(options.timeout, 5000)
    assert.equal(options.killSignal, 'SIGKILL')
    assert.equal(options.maxBuffer, 1024 * 1024)
    assert.deepEqual(JSON.parse(options.input), { version: 1, id: 'upgrade-preflight', method: 'host.inspect', params: {} })
    return { status: 0, stdout: JSON.stringify(value), ...patch }
  }
  const good = { version: 1, id: 'upgrade-preflight', result: host }
  assert.deepEqual(liveRpc('host.inspect', {}, run(good)), host)
  for (const bad of [null, {}, { ...good, version: 2 }, { ...good, id: 'other' }, { ...good, error: {} }, { ...good, extra: 1 }]) {
    assert.throws(() => liveRpc('host.inspect', {}, run(bad)), /RPC_INVALID/)
  }
  for (const patch of [{ error: Error('ETIMEDOUT') }, { signal: 'SIGKILL' }, { status: 1 }, { stdout: '{}\n{}' }]) {
    assert.throws(() => liveRpc('host.inspect', {}, run(good, patch)), /RPC_/)
  }
})
test('shell refuses missing authorization before any installation access', () => {
  const script = readFileSync(new URL('../../../deploy/host/macos/upgrade.sh', import.meta.url), 'utf8')
    .replace('[ "$(uname -s)" = Darwin ] || fail \'macOS required\'', '')
    .replace('[ "$(id -u)" = 0 ] || fail \'upgrade requires administrator privileges\'', '')
  const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /usage:/)
  assert.doesNotMatch(result.stderr, /no installation/)
})

test('shell fixture preserves runtime/config, backs up before replacement, and refuses live QEMU', () => {
  for (const qemuAlive of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'host-upgrade-test-'))
    try {
      const base = join(root, 'base'), stage = join(root, 'stage'), mocks = join(root, 'mocks')
      mkdirSync(mocks)
      const put = (path, value, mode = 0o644) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value, { mode }) }
      for (const dir of [base, stage]) {
        for (const file of ['app/cli.mjs', 'bin/maestrly-host', 'etc/host.json', 'install/check-upgrade.mjs', 'install/verify-package.mjs', 'install/check-compatibility.mjs', 'manifest.json']) put(join(dir, file), dir === base ? 'old' : 'new')
        put(join(dir, 'runtime/bin/node'), '#!/bin/sh\nif [ "$3" = --manifest ]; then echo composed-manifest > "$4"; fi\nexit 0\n', 0o755)
      }
      put(join(base, 'state/host.sqlite'), 'database')
      put(join(base, 'state/disk.qcow2'), 'guest-disk')
      put(join(base, 'runtime/qemu'), 'keep-qemu')
      put(join(stage, 'runtime/qemu'), 'new-qemu')
      put(join(root, 'launchd.plist'), 'plist')
      const mock = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const name = path.basename(process.argv[1]); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, 'calls'))}, name + ' ' + args.join(' ') + '\\n');
if (name === 'uname') console.log('Darwin');
if (name === 'id' || name === 'stat') console.log('0');
if (name === 'pgrep') process.exit(${qemuAlive ? 0 : 1});
if (name === 'ditto') fs.cpSync(args[0], args[1], { recursive: true });
if (name === 'sqlite3') { if (args[1].startsWith('.backup')) fs.copyFileSync(args[0], args[1].split("'")[1]); else console.log('ok'); }
`
      for (const name of ['uname', 'id', 'stat', 'find', 'pgrep', 'ditto', 'sqlite3', 'chown', 'launchctl']) put(join(mocks, name), mock, 0o755)
      const script = readFileSync(new URL('../../../deploy/host/macos/upgrade.sh', import.meta.url), 'utf8')
        .replace('PATH=/usr/bin:/bin:/usr/sbin:/sbin', `PATH=${mocks}:/usr/bin:/bin:/usr/sbin:/sbin`)
        .replace('base=/Library/MaestrlyHost', `base=${base}`)
        .replace('stage=/private/var/tmp/maestrly-host-package', `stage=${stage}`)
        .replace('plist=/Library/LaunchDaemons/com.maestrly.host.plist', `plist=${root}/launchd.plist`)
      put(join(root, 'upgrade.sh'), script)
      const result = spawnSync('/bin/sh', [join(root, 'upgrade.sh'), '--authorize-upgrade', 'a'.repeat(64), '--window-confirmed'], { encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status, qemuAlive ? 1 : 0, result.stderr)
      assert.equal(readFileSync(join(base, 'runtime/qemu'), 'utf8'), 'keep-qemu')
      assert.equal(readFileSync(join(base, 'etc/host.json'), 'utf8'), 'old')
      assert.equal(readFileSync(join(base, 'app/cli.mjs'), 'utf8'), qemuAlive ? 'old' : 'new')
      const calls = readFileSync(join(root, 'calls'), 'utf8')
      if (qemuAlive) { assert.match(result.stderr, /QEMU remains alive/); assert.doesNotMatch(calls, /ditto/); }
      else {
        assert.ok(calls.indexOf('launchctl bootout') < calls.indexOf('ditto ' + base + '/state'))
        assert.ok(calls.indexOf('sqlite3 ' + base + '/state/host.sqlite') < calls.indexOf('ditto ' + stage + '/app'))
        assert.match(calls, /launchctl bootstrap/)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('installation manifest retains original notices/runtime and records configured bytes; drift refuses upgrade', async () => {
  const { installationManifest } = await import('../../../deploy/host/macos/check-upgrade.mjs')
  const { createHash } = await import('node:crypto')
  const hash = text => createHash('sha256').update(text).digest('hex')
  const root = mkdtempSync(join(tmpdir(), 'manifest-upgrade-'))
  try {
    const base = join(root, 'base'), stage = join(root, 'stage')
    mkdirSync(base); mkdirSync(stage)
    const files = ['THIRD_PARTY_NOTICES.md', 'runtime/node', 'etc/host.json', 'app/cli.mjs']
    for (const dir of [base, stage]) {
      for (const file of files) { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), dir === base ? 'original' : 'candidate') }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, nodeVersion: dir === base ? 'old-node' : 'new-node', sources: [dir], files: files.map(path => ({ path, sha256: hash(dir === base ? 'original' : 'candidate') })) }))
    }
    writeFileSync(join(base, 'etc/host.json'), 'configured')
    const next = await installationManifest(base, stage)
    assert.equal(next.nodeVersion, 'old-node')
    assert.deepEqual(next.sources, [base])
    assert.deepEqual(Object.fromEntries(next.files.map(f => [f.path, f.sha256])), { 'THIRD_PARTY_NOTICES.md': hash('original'), 'runtime/node': hash('original'), 'etc/host.json': hash('configured'), 'app/cli.mjs': hash('candidate') })
    assert.match(next.installation.previousManifestSha256, /^[a-f0-9]{64}$/)
    writeFileSync(join(base, 'THIRD_PARTY_NOTICES.md'), 'unexplained-drift')
    await assert.rejects(installationManifest(base, stage), /Retained artifact drift/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
