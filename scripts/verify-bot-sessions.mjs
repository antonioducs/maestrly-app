import { accountBackend, verifySessionAccounts } from './test/bot-session-account-probe.mjs'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createServer, connect } from 'node:net'
import { sha256, verifyInput, validateBuildConfig } from './host-build-utils.mjs'

/** Opt-in local Linux artifact validation. This never reads SSH configuration or uses a managed Host VM. */
export async function verifyBotSessions({ root = process.cwd(), fixture, output, collectDependencies = false, bundlePath, accounts = false } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('ARM64 macOS QEMU/HVF validation required')
  const work = output ?? await mkdtemp(join(root, '.host-lab/sessions-test-'))
  const sockets = await mkdtemp('/private/tmp/msess-')
  const config = validateBuildConfig(JSON.parse(await readFile(join(root, '.host-lab/runtime-build/host-build-with-image.json'), 'utf8')))
  for (const entry of config.files) await verifyInput(config.inputDirectory, entry)
  const image = fixture ?? JSON.parse(await readFile(join(root, '.host-lab/sessions/fixture.json'), 'utf8')).image
  const bin = p => join(config.inputDirectory, p)
  const alias = {
    '@maestrly/host-protocol': join(root, 'packages/host-protocol/src/index.ts'),
    '@maestrly/guest-transport': join(root, 'packages/guest-transport/src/index.ts'),
    '@maestrly/codex-client': join(root, 'packages/codex-client/src/index.ts'),
  }
  const options = { bundle: true, platform: 'node', format: 'esm', target: 'node22', alias, external: ['playwright-core'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } }
  await build({ ...options, entryPoints: { main: join(root, 'apps/bot-runtime/src/main.ts'), 'vm/main': join(root, 'apps/bot-runtime/src/vm/main.ts'), 'tools/mcp-main': join(root, 'apps/bot-runtime/src/tools/mcp-main.ts') }, outdir: join(work, 'app') })
  await build({ ...options, stdin: { contents: "export {JsonChannel} from './packages/host-core/src/qmp.ts'; export {VmSession} from './packages/host-core/src/guest/vm-session.ts'; export {SocketGuestSession} from './packages/host-core/src/guest/session.ts'; export {EgressBroker} from './packages/host-core/src/egress/broker.ts'; export {HostStore} from './packages/host-core/src/persistence/store.ts'; export {AccountAuthority} from './packages/host-core/src/accounts/authority.ts';", resolveDir: root }, outfile: join(work, 'host.mjs') })
  const { JsonChannel, VmSession, SocketGuestSession, EgressBroker, HostStore, AccountAuthority } = await import(pathToFileURL(join(work, 'host.mjs')))
  await build({ ...options, entryPoints: [join(root, 'scripts/test/bot-session-desktop-probe.ts')], outfile: join(work, 'desktop-probe.mjs') })
  const bundleManifest = bundlePath ? JSON.parse(await readFile(bundlePath + '.manifest.json', 'utf8')) : undefined
  if (bundlePath && await sha256(bundlePath) !== bundleManifest.sha256) throw Error('Bundle hash mismatch')
  const capacity = bundleManifest?.sessions ?? { profileId: 'session-candidate', evidenceSha256: '0'.repeat(64), systemMemoryMiB: 384, systemDiskMiB: 4096, maxSessions: 2, perSession: { cpuQuotaPercent: 100, memoryMiB: 768, tasksMax: 256, diskMiB: 1024 } }
  await mkdir(join(work, 'seed'))
  await writeFile(join(work, 'seed/meta-data'), `instance-id: ${randomUUID()}\nlocal-hostname: bot-session-test\n`)
  await writeFile(join(work, 'seed/user-data'), '#cloud-config\nusers: []\ndisable_root: true\nssh_pwauth: false\nruncmd:\n  - [systemctl, start, qemu-guest-agent]\n')
  if (bundlePath) {
    await cp(bundlePath, join(work, 'seed/runtime.tar'))
    await writeFile(join(work, 'seed/install.sh'), execFileSync('/usr/bin/tar', ['-xOf', bundlePath, './install/install.sh'], { maxBuffer: 1024 * 1024 }))
  }
  execFileSync('/usr/bin/hdiutil', ['makehybrid', '-iso', '-joliet', '-default-volume-name', 'CIDATA', '-o', join(work, 'seed.iso'), join(work, 'seed')], { stdio: 'ignore' })
  execFileSync(bin('bin/qemu-img'), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, join(work, 'guest.qcow2'), '12G'], { stdio: 'ignore' })
  await cp(bin('firmware/edk2-arm-vars.fd'), join(work, 'vars.fd'))
  const args = ['-machine', 'virt,accel=hvf', '-cpu', 'host', '-smp', '2', '-m', '2048', '-nodefaults', '-no-user-config', '-display', 'none', '-monitor', 'none', '-nic', 'none', '-serial', `file:${work}/console.log`, '-drive', `if=pflash,format=raw,readonly=on,file=${bin('firmware/edk2-aarch64-code.fd')}`, '-drive', `if=pflash,format=raw,file=${work}/vars.fd`, '-drive', `if=virtio,format=qcow2,file=${work}/guest.qcow2`, '-drive', `if=virtio,format=raw,readonly=on,file=${work}/seed.iso`, '-device', 'virtio-serial-pci']
  for (const [name, port] of [['qga', 'org.qemu.guest_agent.0'], ['control', 'org.maestrly.bot.control.0'], ['egress', 'org.maestrly.bot.egress.0']]) args.push('-chardev', `socket,path=${sockets}/${name},server=on,wait=off,id=${name}`, '-device', `virtserialport,chardev=${name},name=${port}`)
  await writeFile(join(work, 'inputs.json'), JSON.stringify({ image, imageSha256: await sha256(image), args, capacity }, null, 2))
  console.log('VM Linux descartável: preparando duas sessões; evidência em ' + work)
  const child = spawn(bin('bin/qemu-system-aarch64'), args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let qga, control, egress, accountProbe
  const accountApi = accounts ? await accountBackend() : undefined
  const sessions = []
  const peers = new Set()
  const fixtureServer = createServer(socket => { peers.add(socket); socket.on('data', bytes => socket.write('echo:' + bytes)); socket.on('error', () => {}); socket.once('close', () => peers.delete(socket)) })
  await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
  const broker = new EgressBroker({ lookup: async hostname => [{ address: hostname === 'account.test' ? '93.184.216.35' : '93.184.216.34', family: 4 }], hostAddresses: [], dialer: address => new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: address === '93.184.216.35' && accountApi ? accountApi.port : fixtureServer.address().port })
    socket.once('error', reject)
    socket.once('connect', () => { Object.defineProperty(socket, 'remoteAddress', { value: address }); resolve(socket) })
  }) })
  const deadline = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
  try {
    for (let i = 0; i < 90; i++) { try { qga = await JsonChannel.open(`${sockets}/qga`, false, 1000); break } catch { await new Promise(r => setTimeout(r, 1000)) } }
    if (!qga) throw Error('QGA did not start')
    async function execute(path, arg) {
      if (arg.some(value => typeof value !== 'string')) throw Error('Guest argv must contain strings')
      const { pid } = await qga.command('guest-exec', { path, arg, 'capture-output': true })
      for (let i = 0; i < 120; i++) {
        const result = await qga.command('guest-exec-status', { pid })
        if (result.exited) {
          if (result.exitcode !== 0) throw Error(path + ' failed: ' + Buffer.from(result['err-data'] ?? '', 'base64').toString().slice(-1500))
          return Buffer.from(result['out-data'] ?? '', 'base64').toString()
        }
        await new Promise(r => setTimeout(r, 500))
      }
      throw Error('Guest command timed out; no replay')
    }
    async function upload(path, bytes) {
      const handle = await qga.command('guest-file-open', { path, mode: 'wb' })
      try {
        for (let offset = 0; offset < bytes.length; offset += 49152) {
          const data = bytes.subarray(offset, offset + 49152)
          if ((await qga.command('guest-file-write', { handle, 'buf-b64': data.toString('base64') })).count !== data.length) throw Error('Short guest upload')
        }
        await qga.command('guest-file-flush', { handle })
      } finally { await qga.command('guest-file-close', { handle }) }
    }
    if (collectDependencies) {
      const handle = await qga.command('guest-file-open', { path: '/var/lib/maestrly-session-dependencies.tar', mode: 'rb' })
      const chunks = []
      try {
        let size = 0
        for (;;) {
          const data = await qga.command('guest-file-read', { handle, count: 49152 })
          const bytes = Buffer.from(data['buf-b64'] ?? '', 'base64'); size += bytes.length
          if (size > 16 * 1024 * 1024) throw Error('Dependency archive limit')
          chunks.push(bytes)
          if (data.eof) break
        }
      } finally { await qga.command('guest-file-close', { handle }) }
      const path = join(root, '.host-lab/sessions/session-dependencies.tar')
      await writeFile(path, Buffer.concat(chunks), { mode: 0o600 })
      return { work, dependencies: path, sha256: await sha256(path) }
    }
    await execute('/bin/systemctl', ['disable', '--now', 'maestrly-bot-runtime.service', 'maestrly-bot-desktop.service'])
    if (bundlePath) {
      await execute('/bin/mkdir', ['-p', '/mnt/maestrly-session-test'])
      await execute('/bin/mount', ['-o', 'ro', '/dev/disk/by-label/CIDATA', '/mnt/maestrly-session-test'])
      await execute('/bin/sh', ['/mnt/maestrly-session-test/install.sh', '--bundle', '/mnt/maestrly-session-test/runtime.tar', '--sha256', bundleManifest.sha256, '--version', bundleManifest.runtimeVersion])
      await execute('/bin/systemctl', ['start', 'maestrly-bot-vm.service'])
      for (const relative of ['app/main.js', 'app/vm/main.js']) {
        const actual = (await execute('/usr/bin/sha256sum', ['/opt/maestrly-bot/' + relative])).split(' ')[0]
        if (actual !== bundleManifest.files.find(f => f.path === relative).sha256) throw Error('Installed bundle content mismatch')
      }
    } else {
    await execute('/bin/mkdir', ['-p', '/opt/maestrly-bot/app/vm'])
    for (const relative of ['main.js', 'vm/main.js', 'tools/mcp-main.js']) await upload('/opt/maestrly-bot/app/' + relative, await readFile(join(work, 'app', relative)))
    for (const name of ['maestrly-bot-vm.service', 'maestrly-bot-runtime@.service', 'maestrly-bot-desktop@.service']) await upload('/etc/systemd/system/' + name, await readFile(join(root, 'deploy/bot-runtime/linux', name)))
    await upload('/opt/maestrly-bot/install/wait-desktop.sh', await readFile(join(root, 'deploy/bot-runtime/linux/wait-desktop.sh')))
    await upload('/opt/maestrly-bot/install/desktop-session.sh', await readFile(join(root, 'deploy/bot-runtime/linux/desktop-session.sh')))
    await upload('/etc/apparmor.d/maestrly-chromium', await readFile(join(root, 'deploy/bot-runtime/linux/apparmor-maestrly-chromium')))
    await execute('/usr/sbin/apparmor_parser', ['-r', '/etc/apparmor.d/maestrly-chromium'])
    await upload('/opt/maestrly-bot/session-capacity.json', Buffer.from(JSON.stringify(capacity)))
    await upload('/etc/udev/rules.d/90-maestrly-bot.rules', Buffer.from('SUBSYSTEM=="virtio-ports", ATTR{name}=="org.maestrly.bot.*", OWNER="root", GROUP="root", MODE="0600"\n'))
    await execute('/bin/sh', ['-c', 'udevadm control --reload-rules; udevadm trigger --subsystem-match=virtio-ports; udevadm settle; systemctl daemon-reload; systemctl enable --now maestrly-bot-vm.service'])
    }
    await upload('/opt/maestrly-bot/app/network-probe.mjs', await readFile(join(root, 'scripts/test/bot-session-network-probe.mjs')))
    await upload('/opt/maestrly-bot/app/desktop-probe.mjs', await readFile(join(work, 'desktop-probe.mjs')))
    const hostId = randomUUID()
    const firstBoot = (await execute('/bin/cat', ['/proc/sys/kernel/random/boot_id'])).trim()
    control = await VmSession.open(`${sockets}/control`, hostId, 1, 30000)
    if (!control.managed) throw Error('Supervisor handshake missing')
    egress = await VmSession.open(`${sockets}/egress`, hostId, 1, 30000)
    const records = []
    for (const name of ['a', 'b']) {
      const id = randomUUID()
      const record = await control.request('session.create', { sessionId: id, botId: name, profile: capacity.perSession, idempotencyKey: id, adoptLegacy: name === 'a' })
      console.log('Sessão ' + name + ': ' + record.state)
      records.push(record)
      const net = await egress.openRoute(id, record.generation)
      broker.bindSession('test-vm', id, net, { mode: 'offline', domains: [], revision: 1 })
      const stream = await control.openRoute(id, record.generation)
      const session = await SocketGuestSession.fromStream('test-vm', stream, 1, 30000)
      sessions.push(session)
      await session.request('policy.update', { network: { mode: 'offline', domains: [], revision: 1 }, permissionMode: 'ask' })
      if ((await session.request('runtime.inspect', {})).state !== 'ready') throw Error('Runtime not ready')
    }
    const privateRecords = JSON.parse(await execute('/opt/maestrly-bot/runtime/bin/node', ['--input-type=module', '-e', "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync('/var/lib/maestrly-vm/sessions.sqlite',{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT body FROM sessions').all().map(r=>JSON.parse(r.body))));db.close()"]));
    const facts = []
    for (const r of privateRecords) {
      const pid = (await execute('/bin/systemctl', ['show', `maestrly-bot-runtime@${r.id}.service`, '--property=MainPID', '--value'])).trim()
      const home = r.legacy ? '/home/maestrlybot' : '/home/maestrly-sessions/' + r.id
      const state = r.legacy ? '/var/lib/maestrly-bot' : '/var/lib/maestrly-sessions/' + r.id
      const namespaces = (await execute('/usr/bin/readlink', [`/proc/${pid}/ns/net`, `/proc/${pid}/ns/mnt`, `/proc/${pid}/ns/ipc`])).trim().split('\n')
      facts.push({ ...r, pid, home, state, namespaces })
    }
    if (facts[0].uid === facts[1].uid || facts[0].namespaces.some((n, i) => n === facts[1].namespaces[i])) throw Error('Sessions share user or namespace')
    const probe = (r, mode = '') => execute('/usr/bin/systemd-run', ['--quiet', '--wait', '--pipe', '--collect', `--unit=maestrly-probe-${r.id}`, `--slice=maestrly-bots-${r.id.replaceAll('-', '')}.slice`, '/usr/bin/nsenter', '--target', r.pid, '--mount', '--net', '--ipc', '--', '/usr/sbin/runuser', '-u', r.username, '--', '/usr/bin/setpriv', '--no-new-privs', '--', '/usr/bin/env', 'DISPLAY=:10', `HOME=${r.home}`, `XAUTHORITY=${r.state}/Xauthority`, `MAESTRLY_BOT_STATE=${r.state}`, `MAESTRLY_BOT_WORKSPACE=${r.home}/workspace`, `MAESTRLY_BOT_SESSION_ID=${r.id}`, 'MAESTRLY_BOT_DESKTOP_MANAGED=1', '/opt/maestrly-bot/runtime/bin/node', '/opt/maestrly-bot/app/desktop-probe.mjs', r.botId, mode])
    const results = await Promise.all(facts.map(r => probe(r)))
    console.log('Mouse, keyboard and full desktop capture completed in both sessions.')
    const captures = []
    for (const [i, r] of facts.entries()) {
      const result = JSON.parse(results[i].trim().split('\n').at(-1))
      if (result.clicked !== r.botId || result.input !== `input-${r.botId}`) throw Error('Desktop input crossed sessions')
      const info = await sessions[i].request('files.stat', { path: result.screenshot })
      const chunks = []
      for (let offset = 0; offset < info.size; offset += 49152) {
        const response = await sessions[i].request('files.read', { path: result.screenshot, offset, length: Math.min(49152, info.size - offset) })
        chunks.push(Buffer.from(response.dataBase64, 'base64'))
      }
      const bytes = Buffer.concat(chunks)
      const path = join(work, `desktop-${r.botId}.png`)
      await writeFile(path, bytes)
      if (await sha256(path) !== info.digest) throw Error('Captured file digest mismatch')
      captures.push(info.digest)
      const other = facts[1 - i]
      const negative = await execute('/usr/sbin/runuser', ['-u', r.username, '--', '/bin/sh', '-c', `test ! -r '${other.state}/codex/isolation-sentinel' && test ! -r '${other.state}/Xauthority' && test ! -r '${other.home}/workspace/result-${other.botId}.json' && test ! -w '/dev/virtio-ports/org.maestrly.bot.control.0' && echo ISOLATED`])
      if (!negative.includes('ISOLATED')) throw Error('Cross-session file access possible')
    }
    if (captures[0] === captures[1]) throw Error('Desktop captures unexpectedly identical')
    const netProbe = (r, mode, other = '') => execute('/usr/bin/nsenter', ['--target', r.pid, '--mount', '--net', '--ipc', '--', '/usr/sbin/runuser', '-u', r.username, '--', '/usr/bin/setpriv', '--no-new-privs', '--', '/usr/bin/env', `MAESTRLY_BOT_WORKSPACE=${r.home}/workspace`, '/opt/maestrly-bot/runtime/bin/node', '/opt/maestrly-bot/app/network-probe.mjs', mode, r.botId, other])
    for (const [i, r] of facts.entries()) {
      await netProbe(r, 'cross-socket', `/run/maestrly-vm/${facts[1-i].id}/control.sock`)
      await netProbe(r, 'direct')
    }
    if (!(await netProbe(facts[0], 'offline')).includes('DENIED')) throw Error('Offline A reached the network')
    const publicPolicy = { mode: 'blocklist', domains: [], revision: 2 }
    for (let i = 0; i < 2; i++) {
      broker.updatePolicy('test-vm', facts[i].id === facts[0].id ? { mode: 'offline', domains: [], revision: 2 } : publicPolicy, facts[i].id)
      await sessions[i].request('policy.update', { network: i === 0 ? { mode: 'offline', domains: [], revision: 2 } : publicPolicy, permissionMode: 'ask' })
    }
    const bStream = netProbe(facts[1], 'stream')
    bStream.catch(() => {})
    const waitStream = async (index) => {
      for (let n = 0; n < 60; n++) {
        try { await sessions[index].request('files.stat', { path: `stream-${facts[index].botId}.ready` }); return } catch {}
        await new Promise(r => setTimeout(r, 100))
      }
      throw Error('Stream did not open')
    }
    await waitStream(1)
    if (!(await netProbe(facts[0], 'offline')).includes('DENIED')) throw Error('A borrowed B network policy')
    broker.updatePolicy('test-vm', publicPolicy, facts[0].id)
    await sessions[0].request('policy.update', { network: publicPolicy, permissionMode: 'ask' })
    const aStream = netProbe(facts[0], 'stream'); aStream.catch(() => {})
    await waitStream(0)
    broker.updatePolicy('test-vm', { mode: 'blocklist', domains: ['public.test'], revision: 3 }, facts[0].id)
    if (!(await aStream).includes('REVOKED')) throw Error('A stream was not revoked')
    if (broker.activeStreams('test-vm', facts[1].id) !== 1) throw Error('Revoking A affected B network')
    broker.updatePolicy('test-vm', { mode: 'offline', domains: [], revision: 3 }, facts[1].id)
    await bStream
    console.log('Per-session network policy, direct-network denial and stream revocation verified.')
    if (accountApi) accountProbe = await verifySessionAccounts({ backend: accountApi, HostStore, AccountAuthority, work, facts, sessions, execute, upload, reconnect, broker, management: () => control })
    const usage = []
    for (const r of facts) {
      const group = (await execute('/bin/systemctl', ['show', `maestrly-bots-${r.id.replaceAll('-', '')}.slice`, '--property=ControlGroup', '--value'])).trim()
      const counters = await execute('/bin/cat', [`/sys/fs/cgroup${group}/memory.events`])
      if (!/^oom_kill 0$/m.test(counters)) throw Error('A session hit OOM during the test')
      usage.push({ counters, metrics: (await execute('/bin/systemctl', ['show', `maestrly-bots-${r.id.replaceAll('-', '')}.slice`, '--property=MemoryPeak', '--property=CPUUsageNSec', '--property=TasksCurrent'])).trim() })
    }
    const beforeB = await sessions[1].request('runtime.inspect', {})
    await control.request('session.lease', { sessionId: records[0].id, generation: records[0].generation, turnId: 'expiry-test', leaseMs: 1000 })
    let stopped
    for (let n = 0; n < 80; n++) { stopped = await control.request('session.inspect', { sessionId: records[0].id }); if (stopped.state === 'stopped') break; await new Promise(r => setTimeout(r, 200)) }
    if (stopped.state !== 'stopped' || (await sessions[1].request('runtime.inspect', {})).state !== beforeB.state) throw Error('Stopping A affected B')
    records[0] = await control.request('session.start', { sessionId: records[0].id, generation: stopped.generation, idempotencyKey: 'start-after-expiry' })
    async function reconnect(hostGeneration) {
      for (const session of sessions.splice(0)) session.close()
      broker.detach('test-vm'); control.close(); egress.close()
      control = undefined; egress = undefined
      for (let attempt = 0; attempt < 12; attempt++) {
        try { control = await VmSession.open(`${sockets}/control`, hostId, hostGeneration, 10000); break } catch { await new Promise(r => setTimeout(r, 500)) }
      }
      if (!control) throw Error('Supervisor did not reconnect')
      egress = await VmSession.open(`${sockets}/egress`, hostId, hostGeneration, 30000)
      for (const record of records) {
        const current = await control.request('session.inspect', { sessionId: record.id })
        const net = await egress.openRoute(record.id, current.generation)
        broker.bindSession('test-vm', record.id, net, { mode: 'offline', domains: [], revision: 4 })
        const session = await SocketGuestSession.fromStream('test-vm', await control.openRoute(record.id, current.generation), hostGeneration, 30000)
        sessions.push(session)
        await session.request('policy.update', { network: { mode: 'offline', domains: [], revision: 4 }, permissionMode: 'ask' })
        if ((await session.request('runtime.inspect', {})).state !== 'ready') throw Error('Runtime did not recover')
        if (accountProbe) await accountProbe.attach(session)
      }
    }
    await reconnect(2)
    for (const [i, r] of facts.entries()) {
      await sessions[i].request('files.stat', { path: `result-${r.botId}.json` })
      r.pid = (await execute('/bin/systemctl', ['show', `maestrly-bot-runtime@${r.id}.service`, '--property=MainPID', '--value'])).trim()
    }
    await Promise.all(facts.map(r => probe(r, 'resume')))
    console.log('Both sessions reconnected with their files and browser profiles preserved.')
    await qga.notify('guest-shutdown', { mode: 'reboot' }); qga.close()
    qga = undefined
    await new Promise(r => setTimeout(r, 1000))
    for (let attempt = 0; attempt < 90; attempt++) {
      try { qga = await JsonChannel.open(`${sockets}/qga`, false, 1000); const boot = (await execute('/bin/cat', ['/proc/sys/kernel/random/boot_id'])).trim(); if (boot !== firstBoot) break; qga.close(); qga = undefined } catch { qga?.close(); qga = undefined }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!qga) throw Error('Guest reboot not confirmed')
    await reconnect(3)
    for (const [i, r] of facts.entries()) {
      await sessions[i].request('files.stat', { path: `result-${r.botId}.json` })
      r.pid = (await execute('/bin/systemctl', ['show', `maestrly-bot-runtime@${r.id}.service`, '--property=MainPID', '--value'])).trim()
    }
    await Promise.all(facts.map(r => probe(r, 'resume')))
    console.log('Guest reboot preserved both desktops and browser profiles; no real provider account was used.')
    const report = { ...(accountProbe ? { sharedAccount: { ...accountProbe.report, reconnect: true, guestReboot: true } } : {}), bundleSha256: bundleManifest?.sha256, installedBundleVerified: !!bundlePath, reconnect: true, guestReboot: true, browserProfilesPreserved: true, perSessionNetwork: true, streamRevocation: true, sessionLeaseExpiry: true, verified: true, stage: 'two-desktops-and-isolation', sessions: records.length, network: 'none', isolation: true, resources: { cpus: 2, memoryMiB: 2048, diskGiB: 12 }, capacity, captures, usage, input: results.map(result => JSON.parse(result.trim().split('\n').at(-1))), stoppedAWithoutAffectingB: true, paidProviderTest: false }
    await writeFile(join(work, 'runtime-report.json'), JSON.stringify(report, null, 2))
    console.log('Two isolated Linux desktops verified; no real provider credentials used.')
    return { work, report }
  } catch (error) {
    if (qga) {
      try {
        const { pid } = await qga.command('guest-exec', { path: '/bin/journalctl', arg: ['--no-pager', '-n', '160'], 'capture-output': true })
        await new Promise(r => setTimeout(r, 300))
        const result = await qga.command('guest-exec-status', { pid })
        await writeFile(join(work, 'failure.log'), Buffer.from(result['out-data'] ?? '', 'base64'))
      } catch {}
    }
    throw error
  } finally {
    clearTimeout(deadline)
    for (const s of sessions) s.close()
    await accountProbe?.close(); await accountApi?.close()
    broker.close(); control?.close(); egress?.close(); qga?.close()
    for (const peer of peers) peer.destroy()
    await new Promise(resolve => fixtureServer.close(resolve))
    if (child.exitCode === null) { const exit = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exit }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--local-vm')) throw Error('Explicit --local-vm opt-in required')
  await verifyBotSessions({ accounts: process.argv.includes('--accounts') })
}
