// Opt-in local phase 3 validation. A versioned runtime bundle is installed in a disposable
// clone of the phase 2 guest that has NO network interface; the harness then drives the real
// VM supervisor, systemd units, TigerVNC screen server, virtio media lane and XTEST input the
// way the Host does. No SSH, no lab configuration and no managed Host VM are involved.
import { build } from 'esbuild'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { sha256, validateBuildConfig, verifyInput } from './host-build-utils.mjs'
import { RfbClient } from './test/rfb-client.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]
const PORTS = [['qga', 'org.qemu.guest_agent.0'], ['control', 'org.maestrly.bot.control.0'], ['egress', 'org.maestrly.bot.egress.0'], ['desktop', 'org.maestrly.bot.desktop.0']]
const TIGERVNC = '1.13.1+dfsg-2build2'
const codeOf = (error) => error?.code ?? /[A-Z_]{6,}/.exec(String(error?.message ?? error))?.[0]

export async function verifyBotDesktopVm({ root = process.cwd(), bundlePath, fixture, upgradeFrom } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('ARM64 macOS QEMU/HVF validation required')
  if (!bundlePath) throw Error('BUNDLE_REQUIRED: set MAESTRLY_BOT_DESKTOP_BUNDLE to a versioned runtime tar')
  const manifest = JSON.parse(await readFile(`${bundlePath}.manifest.json`, 'utf8'))
  if ((await sha256(bundlePath)) !== manifest.sha256) throw Error('Bundle hash mismatch')
  if (!manifest.capabilities?.includes('desktop.live.v1') || !manifest.sessions) throw Error('Bundle lacks the live desktop or a measured session profile')
  const work = await mkdtemp(join(root, '.host-lab/desktop-vm-'))
  const sockets = await mkdtemp('/private/tmp/mdvm-')
  const config = validateBuildConfig(JSON.parse(await readFile(join(root, '.host-lab/runtime-build/host-build-with-image.json'), 'utf8')))
  for (const entry of config.files) await verifyInput(config.inputDirectory, entry)
  const image = fixture ?? JSON.parse(await readFile(join(root, '.host-lab/sessions/fixture.json'), 'utf8')).image
  const bin = (p) => join(config.inputDirectory, p)
  await build({
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning', external: ['playwright-core'],
    alias: {
      '@maestrly/host-protocol': join(root, 'packages/host-protocol/src/index.ts'),
      '@maestrly/guest-transport': join(root, 'packages/guest-transport/src/index.ts'),
      '@maestrly/codex-client': join(root, 'packages/codex-client/src/index.ts'),
    },
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    stdin: { contents: "export {JsonChannel} from './packages/host-core/src/qmp.ts'; export {VmSession} from './packages/host-core/src/guest/vm-session.ts'; export {DesktopMediaConnector} from './packages/host-core/src/desktop/media-connector.ts'; export {installGuestRuntime} from './packages/host-core/src/guest/install.ts';", resolveDir: root },
    outfile: join(work, 'host.mjs'),
  })
  const { JsonChannel, VmSession, DesktopMediaConnector } = await import(pathToFileURL(join(work, 'host.mjs')).href)
  await mkdir(join(work, 'seed'))
  await writeFile(join(work, 'seed/meta-data'), `instance-id: ${randomUUID()}\nlocal-hostname: bot-desktop-test\n`)
  await writeFile(join(work, 'seed/user-data'), '#cloud-config\nusers: []\ndisable_root: true\nssh_pwauth: false\nruncmd:\n  - [systemctl, start, qemu-guest-agent]\n')
  await cp(bundlePath, join(work, 'seed/runtime.tar'))
  await writeFile(join(work, 'seed/install.sh'), execFileSync('/usr/bin/tar', ['-xOf', bundlePath, './install/install.sh'], { maxBuffer: 1024 * 1024 }))
  let previous
  if (upgradeFrom) {
    // The deployed pre-desktop bundle creates the sessions; the new bundle then updates them in place.
    previous = JSON.parse(await readFile(`${upgradeFrom}.manifest.json`, 'utf8'))
    if ((await sha256(upgradeFrom)) !== previous.sha256) throw Error('Previous bundle hash mismatch')
    if (previous.capabilities?.includes('desktop.live.v1') || !previous.sessions) throw Error('The previous bundle must be a pre-desktop session runtime')
    await cp(upgradeFrom, join(work, 'seed/previous.tar'))
    await writeFile(join(work, 'seed/install-previous.sh'), execFileSync('/usr/bin/tar', ['-xOf', upgradeFrom, './install/install.sh'], { maxBuffer: 1024 * 1024 }))
  }
  execFileSync('/usr/bin/hdiutil', ['makehybrid', '-iso', '-joliet', '-default-volume-name', 'CIDATA', '-o', join(work, 'seed.iso'), join(work, 'seed')], { stdio: 'ignore' })
  execFileSync(bin('bin/qemu-img'), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, join(work, 'guest.qcow2'), '12G'], { stdio: 'ignore' })
  await cp(bin('firmware/edk2-arm-vars.fd'), join(work, 'vars.fd'))
  const args = ['-machine', 'virt,accel=hvf', '-cpu', 'host', '-smp', '2', '-m', '2048', '-nodefaults', '-no-user-config', '-display', 'none', '-monitor', 'none', '-nic', 'none',
    '-serial', `file:${work}/console.log`, '-drive', `if=pflash,format=raw,readonly=on,file=${bin('firmware/edk2-aarch64-code.fd')}`, '-drive', `if=pflash,format=raw,file=${work}/vars.fd`,
    '-drive', `if=virtio,format=qcow2,file=${work}/guest.qcow2`, '-drive', `if=virtio,format=raw,readonly=on,file=${work}/seed.iso`, '-device', 'virtio-serial-pci']
  for (const [name, port] of PORTS) args.push('-chardev', `socket,path=${sockets}/${name},server=on,wait=off,id=${name}`, '-device', `virtserialport,chardev=${name},name=${port}`)
  await writeFile(join(work, 'inputs.json'), JSON.stringify({ image, imageSha256: await sha256(image), bundle: manifest.runtimeVersion, bundleSha256: manifest.sha256, args }, null, 2))
  console.log(`VM Linux descartável sem rede: validando a tela ao vivo; evidência em ${work}`)
  const child = spawn(bin('bin/qemu-system-aarch64'), args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const report = { stage: 'local-vm-live-desktop', network: 'none', bundle: { version: manifest.runtimeVersion, sha256: manifest.sha256 }, checks: {} }
  const check = (name, value) => { report.checks[name] = value === true; if (value !== true) throw Error(`CHECK_FAILED: ${name}`) }
  let qga, control, media
  let verifiedRun = false
  const clients = new Set()
  const deadline = setTimeout(() => child.kill('SIGTERM'), 25 * 60_000)
  try {
    for (let i = 0; i < 120 && !qga; i++) { try { qga = await JsonChannel.open(`${sockets}/qga`, false, 1000) } catch { await sleep(1000) } }
    if (!qga) throw Error('QGA did not start')
    async function execute(path, arg, timeoutMs = 60_000) {
      const { pid } = await qga.command('guest-exec', { path, arg, 'capture-output': true })
      for (const started = Date.now(); Date.now() - started < timeoutMs;) {
        const result = await qga.command('guest-exec-status', { pid })
        if (result.exited) {
          if (result.exitcode !== 0) throw Error(`${path} failed: ${Buffer.from(result['err-data'] ?? '', 'base64').toString().slice(-1500)}`)
          return Buffer.from(result['out-data'] ?? '', 'base64').toString()
        }
        await sleep(300)
      }
      throw Error('Guest command timed out; no replay')
    }
    const sh = (command, timeoutMs) => execute('/bin/sh', ['-c', command], timeoutMs)
    async function upload(path, bytes) {
      const handle = await qga.command('guest-file-open', { path, mode: 'wb' })
      try {
        for (let offset = 0; offset < bytes.length; offset += 49152) {
          const data = bytes.subarray(offset, offset + 49152)
          if ((await qga.command('guest-file-write', { handle, 'buf-b64': data.toString('base64') })).count !== data.length) throw Error('Short guest upload')
        }
        await qga.command('guest-file-flush', { handle })
      } finally {
        await qga.command('guest-file-close', { handle })
      }
    }
    await execute('/bin/systemctl', ['disable', '--now', 'maestrly-bot-runtime.service', 'maestrly-bot-desktop.service'])
    await execute('/bin/mkdir', ['-p', '/mnt/maestrly-desktop-test'])
    await execute('/bin/mount', ['-o', 'ro', '/dev/disk/by-label/CIDATA', '/mnt/maestrly-desktop-test'])
    const hostId = randomUUID()
    let hostGeneration = 1
    const connect = async (generation) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        try { return await VmSession.open(`${sockets}/control`, hostId, generation, 10_000) } catch { await sleep(500) }
      }
      throw Error('Supervisor did not answer')
    }
    const install = (script, bundle, info) => execute('/bin/sh', [`/mnt/maestrly-desktop-test/${script}`, '--bundle', `/mnt/maestrly-desktop-test/${bundle}`, '--sha256', info.sha256, '--version', info.runtimeVersion], 600_000)
    const readCatalog = (expression) => execute('/opt/maestrly-bot/runtime/bin/node', ['--input-type=module', '-e', `import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync('/var/lib/maestrly-vm/sessions.sqlite',{readOnly:true});console.log(JSON.stringify(${expression}));db.close()`])
    const sessionRows = async () => JSON.parse(await readCatalog("db.prepare('SELECT body FROM sessions').all().map(r=>JSON.parse(r.body))"))
    const catalogVersion = async () => JSON.parse(await readCatalog("db.prepare('PRAGMA user_version').get().user_version"))
    const homeOf = (row) => (row.legacy ? '/home/maestrlybot' : `/home/maestrly-sessions/${row.id}`)
    const records = []
    if (previous) {
      // Sessions created and started by the deployed pre-desktop supervisor, with files in each workspace.
      await install('install-previous.sh', 'previous.tar', previous)
      await execute('/bin/systemctl', ['start', 'maestrly-bot-vm.service'])
      control = await connect(hostGeneration)
      for (const name of ['a', 'b']) {
        const id = randomUUID()
        records.push(await control.request('session.create', { sessionId: id, botId: name, profile: previous.sessions.perSession, idempotencyKey: id, adoptLegacy: name === 'a' }, 180_000))
      }
      for (const r of records)
        for (let i = 0; (await control.request('session.inspect', { sessionId: r.id })).state !== 'running'; i++) {
          if (i > 180) throw Error('Previous session did not start')
          await sleep(1000)
        }
      const before = await sessionRows()
      for (const row of before) await execute('/usr/sbin/runuser', ['-u', row.username, '--', '/bin/sh', '-c', `printf 'kept-%s' '${row.botId}' > '${homeOf(row)}/workspace/upgrade-sentinel.txt'`])
      report.upgrade = { from: previous.runtimeVersion, catalogBefore: await catalogVersion(), sessions: before.map((row) => row.id) }
      control.close()
      control = undefined
    }
    const installStarted = performance.now()
    if (previous) {
      // The Host's own installation path (QGA transfer, digest, retention of the earlier tree).
      const { installGuestRuntime } = await import(pathToFileURL(join(work, 'host.mjs')).href)
      await installGuestRuntime(qga, { path: bundlePath, sha256: manifest.sha256, version: manifest.runtimeVersion }, AbortSignal.timeout(1_200_000))
      // Bounded retention: the replaced installation stays as .previous; older copies, the bundle
      // copy and any staging tree are reclaimed, so repeated updates never fill a small guest disk.
      report.upgrade.retained = (await sh('ls -d /opt/maestrly-bot.previous /opt/maestrly-bot.previous-before-* /opt/maestrly-bot.staging-* /var/lib/maestrly/bot-runtime/bundle.tar 2>/dev/null || true')).trim().split('\n').filter(Boolean)
      report.upgrade.previousVersion = JSON.parse(await execute('/bin/cat', ['/opt/maestrly-bot.previous/package.json']).catch(() => '{}')).version ?? null
      check('upgradeKeepsOneEarlierInstall', JSON.stringify(report.upgrade.retained) === JSON.stringify(['/opt/maestrly-bot.previous']) && report.upgrade.previousVersion === previous.runtimeVersion)
    } else await install('install.sh', 'runtime.tar', manifest)
    report.installMs = Math.round(performance.now() - installStarted)
    if (previous) {
      // Like the Host after installing: the VM restarts and the supervisor recovers existing sessions.
      const firstBoot = (await execute('/bin/cat', ['/proc/sys/kernel/random/boot_id'])).trim()
      await qga.notify('guest-shutdown', { mode: 'reboot' })
      qga.close()
      qga = undefined
      await sleep(1000)
      for (let attempt = 0; attempt < 180 && !qga; attempt++) {
        try {
          qga = await JsonChannel.open(`${sockets}/qga`, false, 1000)
          if ((await execute('/bin/cat', ['/proc/sys/kernel/random/boot_id'])).trim() === firstBoot) { qga.close(); qga = undefined }
        } catch { qga?.close(); qga = undefined }
        if (!qga) await sleep(500)
      }
      if (!qga) throw Error('Guest reboot not confirmed')
      hostGeneration = 2
    }
    for (const relative of ['app/vm/main.js', 'app/desktop/services-main.js']) {
      const actual = (await execute('/usr/bin/sha256sum', [`/opt/maestrly-bot/${relative}`])).split(' ')[0]
      check(`installed:${relative}`, actual === manifest.files.find((f) => f.path === relative)?.sha256)
    }
    report.guestPackages = { tigervnc: (await execute('/usr/bin/dpkg-query', ['-W', `-f=\${Version}`, 'tigervnc-scraping-server'])).trim() }
    check('pinnedScreenServer', report.guestPackages.tigervnc === TIGERVNC)
    check('guestHasNoNic', (await sh("ls /sys/class/net | grep -vx lo | wc -l")).trim() === '0')
    if (!previous) await execute('/bin/systemctl', ['start', 'maestrly-bot-vm.service'])
    control = await connect(hostGeneration)
    check('supervisorHandshake', control.managed === true)
    media = new DesktopMediaConnector(hostId, hostGeneration, () => `${sockets}/desktop`)
    const vm = await control.request('vm.inspect', {})
    report.capabilities = vm.capabilities
    check('liveCapabilities', vm.capabilities.includes('desktop.live.v1') && vm.capabilities.includes('desktop.handoff.v1'))
    if (previous) {
      // Records from before the upgrade carry the old generation; only the recovered ones count.
      records.splice(0)
      for (const id of report.upgrade.sessions) {
        let info
        let settled = false
        for (let i = 0; i < 180 && !settled; i++) {
          info = await control.request('session.inspect', { sessionId: id }).catch(() => undefined)
          // Recovery bumps the generation when it restarts a session: wait for the settled one,
          // exactly as the Host re-inspects the generation before every desktop step.
          settled = info?.state === 'running' && (await control.request('desktop.inspect', { sessionId: id, generation: info.generation }).then(() => true, () => false))
          if (!settled) await sleep(1000)
        }
        if (!settled) throw Error(`UPGRADED_SESSION_NOT_SETTLED: ${JSON.stringify(info)}`)
        records.push(info)
      }
      const after = await sessionRows()
      report.upgrade.catalogAfter = await catalogVersion()
      report.upgrade.sentinels = []
      for (const row of after) report.upgrade.sentinels.push(await execute('/bin/cat', [`${homeOf(row)}/workspace/upgrade-sentinel.txt`]))
      check('upgradeKeepsSessions', after.length === 2 && report.upgrade.sessions.every((id) => after.some((row) => row.id === id)) && records.every((r) => r?.state === 'running'))
      check('upgradeMigratesCatalog', report.upgrade.catalogBefore < 2 && report.upgrade.catalogAfter === 2)
      check('upgradeKeepsFiles', after.every((row, i) => report.upgrade.sentinels[i] === `kept-${row.botId}`))
    } else
      for (const name of ['a', 'b']) {
        const id = randomUUID()
        records.push(await control.request('session.create', { sessionId: id, botId: name, profile: manifest.sessions.perSession, idempotencyKey: id, adoptLegacy: name === 'a' }, 180_000))
      }
    const inspect = (r) => control.request('desktop.inspect', { sessionId: r.id, generation: r.generation })
    const until = async (r, predicate, timeoutMs, label) => {
      let last
      for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(500)) {
        last = await inspect(r).catch((error) => ({ error: codeOf(error) }))
        if (predicate(last)) return last
      }
      throw Error(`${label}: ${JSON.stringify(last)}`)
    }
    const ready = (d) => d.services === 'running' && d.automation === 'running' && d.capabilities?.length === 2 && !!d.desktopGeneration && d.width === 1280 && d.height === 800
    for (const r of records) await until(r, ready, 180_000, 'DESKTOP_NOT_READY')
    const rows = JSON.parse(await execute('/opt/maestrly-bot/runtime/bin/node', ['--input-type=module', '-e', "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync('/var/lib/maestrly-vm/sessions.sqlite',{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT body FROM sessions').all().map(r=>JSON.parse(r.body))));db.close()"]))
    const facts = []
    for (const r of records) {
      const row = rows.find((candidate) => candidate.id === r.id)
      const home = row.legacy ? '/home/maestrlybot' : `/home/maestrly-sessions/${r.id}`
      const state = row.legacy ? '/var/lib/maestrly-bot' : `/var/lib/maestrly-sessions/${r.id}`
      const unit = (kind) => `maestrly-bot-${kind}@${r.id}.service`
      const pid = (await execute('/bin/systemctl', ['show', unit('desktop'), '--property=MainPID', '--value'])).trim()
      facts.push({ ...r, username: row.username, home, state, pid, unit, slice: `maestrly-bots-${r.id.replaceAll('-', '')}.slice` })
    }
    const [a, b] = facts
    const env = (f) => ['/usr/bin/env', 'DISPLAY=:10', `XAUTHORITY=${f.state}/Xauthority`, `HOME=${f.home}`, 'LANG=C.UTF-8']
    const inSession = (f, command) => execute('/usr/bin/nsenter', ['--target', f.pid, '--mount', '--net', '--ipc', '--', '/usr/sbin/runuser', '-u', f.username, '--', ...env(f), '/bin/sh', '-c', command])
    const launch = (f, name, xtermArgs) => execute('/usr/bin/systemd-run', ['--quiet', '--collect', `--unit=${name}-${f.id}`, `--slice=${f.slice}`, '/usr/bin/nsenter', '--target', f.pid, '--mount', '--net', '--ipc', '--', '/usr/sbin/runuser', '-u', f.username, '--', ...env(f), '/usr/bin/xterm', '-u8', ...xtermArgs])
    const runtimePid = async (f) => (await execute('/bin/systemctl', ['show', f.unit('runtime'), '--property=MainPID', '--value'])).trim()
    const bRuntimeBefore = await runtimePid(b)
    const typed = `${a.home}/desktop-typed.txt`
    await launch(a, 'maestrly-typing', ['-geometry', '60x8+100+100', '-e', '/bin/sh', '-c', `exec cat > ${typed}`])
    await sleep(2500)
    async function viewer(f) {
      const grantId = randomUUID()
      const started = performance.now()
      const info = await control.request('desktop.viewer.open', { sessionId: f.id, generation: f.generation, grantId })
      const stream = await media.open('local-vm', { sessionId: f.id, generation: f.generation, grantId })
      const client = await RfbClient.connect(stream)
      clients.add(client)
      await client.update(false, 10_000)
      return { client, grantId, info, f, firstFrameMs: Math.round(performance.now() - started) }
    }
    const closeViewer = async (v) => {
      v.client.close()
      clients.delete(v.client)
      await control.request('desktop.viewer.close', { sessionId: v.f.id, grantId: v.grantId }).catch(() => {})
    }
    const va = await viewer(a)
    const vb = await viewer(b)
    report.firstFrameMs = { a: va.firstFrameMs, b: vb.firstFrameMs }
    check('framebuffer1280x800', va.client.width === 1280 && va.client.height === 800 && vb.client.width === 1280)
    check('botsShowTheirOwnScreens', va.client.digest() !== vb.client.digest())
    check('screenServerHasNoTcpListener', !(await execute('/usr/bin/nsenter', ['--target', a.pid, '--net', '--', '/usr/bin/ss', '-ltnpH'])).includes('X0tigervnc'))
    // Hostile viewer: RFB input, clipboard and resize never reach the X server.
    const pointerA = await inSession(a, 'xdotool getmouselocation')
    const pointerB = await inSession(b, 'xdotool getmouselocation')
    va.client.sendPointer(900, 700, 1)
    va.client.sendPointer(900, 700, 0)
    va.client.sendKey(0x61, true)
    va.client.sendKey(0x61, false)
    va.client.sendCutText('segredo-do-observador')
    va.client.sendSetDesktopSize(640, 480)
    await sleep(800)
    report.hostile = {
      pointerUnchanged: (await inSession(a, 'xdotool getmouselocation')) === pointerA,
      typed: await inSession(a, `cat ${typed}`),
      dimensions: (await inSession(a, "xdpyinfo | awk '/dimensions/{print $2}'")).trim(),
      connectionAlive: !va.client.closed,
    }
    check('hostileRfbIgnored', report.hostile.pointerUnchanged && report.hostile.typed === '' && report.hostile.dimensions === '1280x800' && report.hostile.connectionAlive)
    // Two viewers of one bot share the screen; a third is refused by the guest.
    const va2 = await viewer(a)
    const third = await control.request('desktop.viewer.open', { sessionId: a.id, generation: a.generation, grantId: randomUUID() }).then(() => 'opened', codeOf)
    report.viewers = { secondOnSameBot: !va2.client.closed, third }
    check('viewerLimitPerBot', report.viewers.secondOnSameBot && third === 'VIEWER_LIMIT')
    await closeViewer(va2)
    // Takeover of A: automation stops, display and graphical services stay, B is untouched.
    const before = await inspect(a)
    let epoch = before.epoch + 1
    const network = { mode: 'offline', domains: [], revision: 1 }
    const takeoverStarted = performance.now()
    await control.request('desktop.hold', { sessionId: a.id, generation: a.generation, epoch, idempotencyKey: randomUUID(), network })
    const human = await control.request('desktop.acquire', { sessionId: a.id, generation: a.generation, epoch, idempotencyKey: randomUUID() }, 60_000)
    report.takeoverMs = Math.round(performance.now() - takeoverStarted)
    check('takeoverStopsOnlyAutomation', human.mode === 'human' && human.automation === 'stopped' && human.services === 'running' && human.desktopGeneration === before.desktopGeneration && !va.client.closed)
    const bDuring = await inspect(b)
    check('otherBotUnaffectedByTakeover', bDuring.mode === 'bot' && bDuring.automation === 'running' && (await runtimePid(b)) === bRuntimeBefore)
    let renewing = true
    const renewals = []
    const renewer = (async () => {
      while (renewing) {
        const started = performance.now()
        await control.request('desktop.lease', { sessionId: a.id, generation: a.generation, epoch, leaseMs: 12_000 }).catch((error) => renewals.push(codeOf(error)))
        renewals.push(Math.round(performance.now() - started))
        for (let i = 0; i < 30 && renewing; i++) await sleep(100)
      }
    })()
    let sequence = 0
    const input = (events, seq = ++sequence) => control.request('desktop.input', { sessionId: a.id, generation: a.generation, epoch, desktopGeneration: human.desktopGeneration, sequence: seq, events })
    await input([{ kind: 'pointer', x: 250, y: 140 }, { kind: 'button', button: 'left', down: true, x: 250, y: 140 }, { kind: 'button', button: 'left', down: false, x: 250, y: 140 }])
    await input([{ kind: 'text', text: 'ação €' }, { kind: 'key', code: 'Enter', keysym: 0xff0d, down: true }, { kind: 'key', code: 'Enter', keysym: 0xff0d, down: false }])
    await sleep(600)
    report.input = {
      pointer: (await inSession(a, 'xdotool getmouselocation')).split(' ').slice(0, 2).join(' '),
      typed: await inSession(a, `cat ${typed}`),
      otherPointerUnchanged: (await inSession(b, 'xdotool getmouselocation')) === pointerB,
      replay: await input([{ kind: 'pointer', x: 10, y: 10 }], sequence).then(() => 'applied', codeOf),
    }
    check('humanInputReachesExactSession', report.input.pointer === 'x:250 y:140' && report.input.typed === 'ação €\n' && report.input.otherPointerUnchanged)
    check('inputSequenceNeverReplayed', report.input.replay === 'INPUT_SEQUENCE_INVALID')
    // Input-to-pixel through the supervisor RPC (control lane) and the media lane.
    const samples = []
    for (let i = 0; i < 30; i++) {
      const digest = va.client.digest()
      const started = performance.now()
      await input([{ kind: 'text', text: 'x' }])
      while (va.client.digest() === digest && performance.now() - started < 3000) await va.client.update(true, 1000).catch(() => {})
      samples.push(performance.now() - started)
    }
    report.inputToPixelMs = { p50: Math.round(percentile(samples, 50)), p95: Math.round(percentile(samples, 95)), samples: samples.length, note: 'desktop.input over the virtio control lane, XTEST in the session, pixel observed over the virtio media lane with a Raw-encoding test client; excludes Host socket, SSH and the app' }
    await launch(a, 'maestrly-scroll', ['-geometry', '100x30+300+300', '-e', '/bin/sh', '-c', 'while :; do date +%s%N; done'])
    await sleep(1500)
    // The generator must be visibly running, otherwise the rate says nothing about the lane.
    report.scroller = {
      unit: (await execute('/bin/systemctl', ['show', `maestrly-scroll-${a.id}.service`, '--property=ActiveState', '--property=SubState', '--property=Result'])).trim().split('\n').join(' '),
      xterms: (await inSession(a, 'xdotool search --class xterm 2>/dev/null | wc -l')).trim(),
    }
    const counted = va.client.updates
    const window = performance.now()
    while (performance.now() - window < 3000) await va.client.update(true, 1000).catch(() => {})
    const windowMs = performance.now() - window
    report.updatesPerSecond = Math.round(((va.client.updates - counted) / (windowMs / 1000)) * 10) / 10
    report.updateWindow = { updates: va.client.updates - counted, ms: Math.round(windowMs), viewerAlive: !va.client.closed }
    // Same generator read directly from the private socket inside the guest: lane versus server.
    report.directUpdatesPerSecond = await (async () => {
      await execute('/bin/mkdir', ['-p', '/var/tmp/maestrly-desktop-test'])
      for (const name of ['rfb-client.mjs', 'rfb-rate.mjs']) await upload(`/var/tmp/maestrly-desktop-test/${name}`, await readFile(join(root, 'scripts/test', name)))
      const out = await execute('/opt/maestrly-bot/runtime/bin/node', ['/var/tmp/maestrly-desktop-test/rfb-rate.mjs', `/run/maestrly-desktop/${a.id}/rfb.sock`], 30_000)
      return JSON.parse(out.trim().split('\n').at(-1)).updatesPerSecond
    })().catch((error) => `unavailable: ${String(error?.message ?? error).slice(0, 120)}`)
    report.targets = { updatesPerSecondAtLeast10: report.updatesPerSecond >= 10, inputToPixelP95AtMost250: report.inputToPixelMs.p95 <= 250, firstFrameAtMost5000: Math.max(va.firstFrameMs, vb.firstFrameMs) <= 5000 }
    await execute('/bin/systemctl', ['stop', `maestrly-scroll-${a.id}.service`]).catch(() => {})
    // A controller that stops renewing loses control: the bot pauses and input is refused.
    renewing = false
    await renewer
    report.renewMs = { max: Math.max(...renewals.filter((v) => typeof v === 'number')), failures: renewals.filter((v) => typeof v !== 'number') }
    const expiryStarted = performance.now()
    await until(a, (d) => d.mode === 'paused', 20_000, 'LEASE_DID_NOT_EXPIRE')
    report.leaseExpiry = { pausedAfterMs: Math.round(performance.now() - expiryStarted), input: await input([{ kind: 'pointer', x: 5, y: 5 }]).then(() => 'applied', codeOf) }
    check('lostControllerPauses', report.leaseExpiry.input === 'CONTROL_EXPIRED' && (await inspect(a)).automation === 'stopped')
    // Take control again, then restart the supervisor: no controller survives a restart.
    epoch++
    await control.request('desktop.hold', { sessionId: a.id, generation: a.generation, epoch, idempotencyKey: randomUUID(), network })
    check('reacquire', (await control.request('desktop.acquire', { sessionId: a.id, generation: a.generation, epoch, idempotencyKey: randomUUID() }, 60_000)).mode === 'human')
    for (const client of clients) client.close()
    clients.clear()
    await execute('/bin/systemctl', ['restart', 'maestrly-bot-vm.service'])
    control.close()
    media.close()
    control = await connect(++hostGeneration)
    media = new DesktopMediaConnector(hostId, hostGeneration, () => `${sockets}/desktop`)
    const afterRestart = await until(a, (d) => d.mode !== undefined, 30_000, 'NO_STATE_AFTER_RESTART')
    report.supervisorRestart = { mode: afterRestart.mode, automation: afterRestart.automation, services: afterRestart.services }
    check('restartRevokesControl', afterRestart.mode === 'paused' && afterRestart.automation === 'stopped' && afterRestart.services === 'running')
    // Return: fresh capture from the graphical services, then automation resumes.
    epoch++
    const release = await control.request('desktop.release', { sessionId: a.id, generation: a.generation, epoch, idempotencyKey: randomUUID() })
    const capture = await control.request('desktop.capture', { sessionId: a.id, generation: a.generation, epoch, observationId: randomUUID() }, 60_000)
    const resumed = await control.request('desktop.resume', { sessionId: a.id, generation: a.generation, epoch, idempotencyKey: randomUUID() }, 60_000)
    report.return = { release: release.mode, capture: { size: capture.size, digest: capture.digest, sameDesktop: capture.desktopGeneration === human.desktopGeneration }, resumed: resumed.mode }
    check('returnWithFreshCapture', release.mode === 'resuming' && capture.size > 0 && report.return.capture.sameDesktop && resumed.mode === 'bot')
    await until(a, (d) => d.mode === 'bot' && d.automation === 'running', 60_000, 'AUTOMATION_DID_NOT_RESUME')
    const bAfter = await inspect(b)
    check('otherBotUntouchedThroughout', bAfter.mode === 'bot' && bAfter.automation === 'running' && (await runtimePid(b)) === bRuntimeBefore)
    // Viewer after restart works; the last viewer leaving stops only the screen server.
    const again = await viewer(a)
    report.viewerAfterRestartMs = again.firstFrameMs
    await closeViewer(again)
    await sleep(6500)
    report.transmitters = (await sh('pgrep -xc X0tigervnc || true')).trim()
    report.xAlive = (await inSession(a, 'xdpyinfo >/dev/null 2>&1 && echo yes || echo no')).trim()
    check('transmitterStopsAfterLastViewer', report.transmitters === '0' && report.xAlive === 'yes')
    // The managed Chromium opens inside the graphical services, the way the bot's browser tools use
    // it: through the agent socket, as the session user, with that session's sandbox and budget.
    // B is used because it stayed in bot mode throughout; its gate is open.
    const checkDirectory = `${b.home}/workspace/.maestrly-browser-check`
    await execute('/usr/sbin/runuser', ['-u', b.username, '--', '/bin/mkdir', '-p', checkDirectory])
    await upload(`${checkDirectory}/agent-check.mjs`, await readFile(join(root, 'scripts/test/browser-agent-check.mjs')))
    await upload(`${checkDirectory}/page.html`, Buffer.from('<!doctype html><title>maestrly-browser-ok</title><h1>Chromium gerenciado</h1>'))
    await execute('/bin/chown', ['-R', `${b.username}:${b.username}`, checkDirectory])
    const browserOut = await inSession(b, `/opt/maestrly-bot/runtime/bin/node ${checkDirectory}/agent-check.mjs ${b.state}/desktop-agent.sock file://${checkDirectory}/page.html`)
    report.browser = JSON.parse(browserOut.trim().split('\n').at(-1))
    await sleep(1000)
    report.browser.windows = Number((await inSession(b, 'xdotool search --onlyvisible --class chrom 2>/dev/null | wc -l')).trim())
    // Chromium's own sandbox stays on: its renderers run under seccomp-BPF (Seccomp: 2).
    report.browser.rendererSeccomp = (await sh(`for p in $(pgrep -u ${b.username} -f 'chromium/chrome.*--type=renderer'); do awk '/^Seccomp:/{print $2}' /proc/$p/status; done | sort -u | tr '\\n' ' '`)).trim()
    check('managedBrowserOpensInSession', report.browser.ok === true && report.browser.title === 'maestrly-browser-ok' && report.browser.windows > 0 && report.browser.rendererSeccomp === '2')
    report.resources = []
    for (const f of facts) {
      const group = (await execute('/bin/systemctl', ['show', f.slice, '--property=ControlGroup', '--value'])).trim()
      const events = await execute('/bin/cat', [`/sys/fs/cgroup${group}/memory.events`])
      const limits = (await execute('/bin/systemctl', ['show', f.slice, '--property=MemoryMax', '--property=TasksMax', '--property=MemoryPeak'])).trim()
      report.resources.push({ bot: f.botId, limits, oomKill: /^oom_kill (\d+)$/m.exec(events)?.[1] })
      check(`budgetUnchanged:${f.botId}`, limits.includes(`MemoryMax=${manifest.sessions.perSession.memoryMiB * 1024 * 1024}`) && limits.includes(`TasksMax=${manifest.sessions.perSession.tasksMax}`))
      check(`noOom:${f.botId}`, report.resources.at(-1).oomKill === '0')
    }
    report.verified = Object.values(report.checks).every(Boolean)
    report.measuredAt = new Date().toISOString()
    report.scope = 'Local disposable VM without NIC: supervisor, systemd units, TigerVNC, virtio control and media lanes, XTEST. Host socket, SSH, the packaged app and the Mac mini are validated separately.'
    await writeFile(join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    verifiedRun = report.verified === true
    return { work, report }
  } catch (error) {
    report.verified = false
    report.error = String(error?.message ?? error).slice(0, 600)
    await writeFile(join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {})
    if (qga) {
      try {
        const { pid } = await qga.command('guest-exec', { path: '/bin/journalctl', arg: ['--no-pager', '-n', '300'], 'capture-output': true })
        await sleep(500)
        const result = await qga.command('guest-exec-status', { pid })
        await writeFile(join(work, 'failure.log'), Buffer.from(result['out-data'] ?? '', 'base64'))
      } catch {}
    }
    throw Object.assign(error, { work })
  } finally {
    clearTimeout(deadline)
    for (const client of clients) client.close()
    media?.close()
    control?.close()
    qga?.close()
    if (child.exitCode === null) { const exit = new Promise((r) => child.once('exit', r)); child.kill('SIGTERM'); await exit }
    // A verified run keeps its report, console and inputs; the large disposable overlay, seed ISO
    // and bundle copy are removed. A failed run keeps everything for investigation.
    if (verifiedRun) for (const file of ['guest.qcow2', 'seed.iso', 'seed/runtime.tar', 'seed/previous.tar']) await rm(join(work, file), { force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  throw Error('Run through: MAESTRLY_BOT_DESKTOP_BUNDLE=<tar> node scripts/verify-bot-desktop.mjs --local-vm')
