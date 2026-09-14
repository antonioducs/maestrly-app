#!/usr/bin/env node
import { readFile, mkdir, writeFile, lstat, open, cp, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyPackage } from '../deploy/host/macos/verify-package.mjs'
import { randomUUID } from 'node:crypto'
export const DOCTOR_SCRIPT = readFileSync(new URL('../deploy/host/macos/doctor.sh', import.meta.url), 'utf8')
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw Error('Explicit local lab configuration required')
  const allowed = new Set([
    'sshAlias',
    'expectedIdentity',
    'namespace',
    'caps',
    'authorizeInstall',
    'authorizeSmoke',
    'runtimeId',
    'imageId',
    'packageDirectory',
    'manifestPath',
    'manifestSha256',
    'authorizeDeleteData',
    'operator',
    // Phase 2 bot laboratory (opt-in): explicit VM selection and guest preparation consent.
    'botVmId',
    'allowGuestPreparation',
    'authorizeBotSmoke',
    'botBundlePath',
    'botBundleSha256',
  ])
  if (Object.keys(config).some((k) => !allowed.has(k))) throw Error('Unknown lab configuration key')
  if (typeof config.sshAlias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(config.sshAlias))
    throw Error('Invalid explicit SSH alias')
  if (
    typeof config.expectedIdentity !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.expectedIdentity)
  )
    throw Error('Expected IOPlatformUUID required')
  if (typeof config.namespace !== 'string' || !/^lab-[a-z0-9][a-z0-9-]{0,39}$/.test(config.namespace))
    throw Error('A lab- namespace is required')
  if (!config.caps || Object.keys(config.caps).sort().join(',') !== 'cpus,diskGiB,memoryMiB')
    throw Error('Explicit resource caps required')
  for (const [key, max] of Object.entries({ cpus: 128, memoryMiB: 1048576, diskGiB: 16384 }))
    if (!Number.isSafeInteger(config.caps[key]) || config.caps[key] < 1 || config.caps[key] > max)
      throw Error('Invalid resource cap')
  for (const key of ['authorizeInstall', 'authorizeSmoke', 'authorizeDeleteData'])
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw Error('Authorization must be boolean')
  for (const key of ['runtimeId', 'imageId'])
    if (
      config[key] !== undefined &&
      (typeof config[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config[key]))
    )
      throw Error('Invalid catalogue identifier')
  for (const key of ['packageDirectory', 'manifestPath'])
    if (
      config[key] !== undefined &&
      (typeof config[key] !== 'string' || !config[key].startsWith('/') || config[key].includes('\0'))
    )
      throw Error('Explicit absolute package paths required')
  if (config.manifestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(config.manifestSha256))
    throw Error('Invalid manifest SHA256')
  if (
    config.operator !== undefined &&
    config.operator !== null &&
    (typeof config.operator !== 'string' || !/^[a-z][a-z0-9_-]{0,30}$/.test(config.operator))
  )
    throw Error('Invalid local operator')
  if (config.botVmId !== undefined && (typeof config.botVmId !== 'string' || !/^[0-9a-f-]{36}$/i.test(config.botVmId)))
    throw Error('botVmId must be the exact VM identifier chosen for preparation')
  for (const key of ['allowGuestPreparation', 'authorizeBotSmoke'])
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw Error('Authorization must be boolean')
  if (config.botBundlePath !== undefined && (typeof config.botBundlePath !== 'string' || !config.botBundlePath.startsWith('/')))
    throw Error('Explicit absolute bot bundle path required')
  if (config.botBundleSha256 !== undefined && !/^[a-f0-9]{64}$/.test(config.botBundleSha256)) throw Error('Invalid bot bundle SHA256')
  return config
}
export function sshArguments(config) {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ForwardX11=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '--',
    config.sshAlias,
    '/bin/sh -s',
  ]
}
export function ssh(config, command, input, timeout = 30000) {
  return new Promise((resolveResult, reject) => {
    const args = sshArguments(config)
    args[args.length - 1] = command
    const child = spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = Buffer.alloc(0)
    let failed = false
    const fail = () => {
      if (failed) return
      failed = true
      child.kill('SIGTERM')
      reject(Error('Remote command failed or exceeded limits'))
    }
    const timer = setTimeout(fail, timeout)
    child.stdout.on('data', (chunk) => {
      output = Buffer.concat([output, chunk])
      if (output.length > 1024 * 1024) fail()
    })
    // Do not persist SSH diagnostics, which may expose local paths or proxy secrets.
    child.stderr.resume()
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failed) return
      if (code !== 0 && code !== 2) {
        fail()
        return
      }
      resolveResult({ code, stdout: output.toString('utf8') })
    })
    if (input && typeof input.pipe === 'function') {
      input.on('error', fail)
      input.pipe(child.stdin)
    } else child.stdin.end(input)
  })
}
export async function remoteDoctor(config) {
  const result = await ssh(config, '/bin/sh -s', DOCTOR_SCRIPT)
  const report = JSON.parse(result.stdout)
  if (report.facts?.identity?.toUpperCase() !== config.expectedIdentity.toUpperCase())
    throw Error('Remote hardware identity mismatch')
  return report
}
export async function rpc(config, method, params) {
  const id = randomUUID()
  const request = { version: 1, id, method, params }
  const { stdout, code } = await ssh(
    config,
    '/Library/MaestrlyHost/bin/maestrly-host rpc-stdio',
    `${JSON.stringify(request)}\n`,
    45000
  )
  const reply = JSON.parse(stdout)
  if (code !== 0 || reply.version !== 1 || reply.id !== id || reply.error || !Object.hasOwn(reply, 'result'))
    throw Error(`Host API ${method} failed`)
  return reply.result
}
// Each journal entry is fsynced before the next remote effect or poll.
export async function record(directory, name, value) {
  const file = await open(resolve(directory, `${name}.json`), 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  const parent = await open(directory, 'r')
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}
export async function transfer(config, runDirectory, remote = ssh) {
  if (!config.packageDirectory || !config.manifestPath || !config.manifestSha256)
    throw Error('Transfer requires explicit package and manifest paths plus SHA256')
  await verifyPackage(config.packageDirectory, config.manifestPath, config.manifestSha256)
  const snapshot = await mkdtemp(resolve(tmpdir(), 'maestrly-host-transfer-'))
  try {
    await cp(config.packageDirectory, resolve(snapshot, 'package'), { recursive: true, dereference: false })
    await verifyPackage(resolve(snapshot, 'package'), resolve(snapshot, 'package/manifest.json'), config.manifestSha256)
    await record(runDirectory, 'transfer-intent', {
      manifestSha256: config.manifestSha256,
      stage: '/private/var/tmp/maestrly-host-package',
    })
    // Only a locally generated archive of the verified private snapshot is transmitted.
    const tar = spawn('/usr/bin/tar', ['-cf', '-', '-C', resolve(snapshot, 'package'), '.'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' },
    })
    const completed = new Promise((resolveResult, reject) => {
      tar.on('error', reject)
      tar.on('close', (code) => (code === 0 ? resolveResult() : reject(Error('Package archive failed'))))
    })
    try {
      const result = await remote(
        config,
        'umask 077; /bin/mkdir /private/var/tmp/maestrly-host-package && /usr/bin/tar -xf - -C /private/var/tmp/maestrly-host-package',
        tar.stdout,
        600000
      )
      await completed
      if (result.code !== 0) throw Error('Package transfer failed')
    } catch (error) {
      tar.kill()
      await completed.catch(() => {})
      throw error
    }
    const result = {
      status: 'needs_action',
      transferred: true,
      manifestSha256: config.manifestSha256,
      reason: 'Administrator must review staging and establish root ownership before authorized install',
    }
    await record(runDirectory, 'transfer-result', result)
    return result
  } finally {
    await rm(snapshot, { recursive: true, force: true })
  }
}
export async function smoke(config, runDirectory, api = (method, params) => rpc(config, method, params)) {
  if (!config.imageId || !config.runtimeId) throw Error('Smoke requires explicit imageId and runtimeId')
  const host = await api('host.inspect', {})
  if (typeof host.id !== 'string' || !host.id) throw Error('Missing persistent host identity')
  const images = await api('image.list', {})
  const image = images.find((image) => image.id === config.imageId && image.available)
  if (
    !image ||
    !host.supported ||
    !host.runtimes?.some((runtime) => runtime.id === config.runtimeId && runtime.available)
  )
    throw Error('Selected image or runtime unavailable')
  const resources = {
    cpus: image.minimumCpus ?? 1,
    memoryMiB: image.minimumMemoryMiB ?? 256,
    diskGiB: image.virtualSizeGiB,
  }
  if (Object.values(resources).some((n) => !Number.isSafeInteger(n) || n < 1)) throw Error('Invalid image minima')
  if (
    Object.entries(resources).some(
      ([key, value]) =>
        !Number.isFinite(host.allocated?.[key]) ||
        !Number.isFinite(host.capacity?.[key]) ||
        host.allocated[key] + 2 * value > Math.min(config.caps[key], host.capacity[key])
    )
  )
    return { status: 'blocked', concurrency: 'blocked: capacity cannot admit two image minima' }
  for (const [key, preferred] of Object.entries({ cpus: 2, memoryMiB: 2048 }))
    resources[key] = Math.max(
      resources[key],
      Math.min(preferred, Math.floor((Math.min(config.caps[key], host.capacity[key]) - host.allocated[key]) / 2))
    )
  const before = await api('vm.list', {})
  if (
    !Array.isArray(before) ||
    before.some((vm) => vm.state !== 'removed' && vm.name?.startsWith(`${config.namespace}-`))
  )
    throw Error('Namespace already in use; inspect prior report')
  let sequence = 0
  const journal = async (kind, value) => record(runDirectory, `${String(sequence++).padStart(4, '0')}-${kind}`, value)
  async function operation(method, params) {
    const request = { ...params, idempotencyKey: randomUUID() }
    await journal('intent', { method, params: request })
    const accepted = await api(method, request)
    if (typeof accepted.id !== 'string') throw Error('Missing operation identifier')
    await journal('accepted', { method, params: request, operation: accepted })
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      const current = await api('operation.get', { operationId: accepted.id })
      if (current.status === 'succeeded') {
        await journal('completed', current)
        return current
      }
      if (['failed', 'cancelled'].includes(current.status)) throw Error('Lifecycle operation failed; inspect journal')
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw Error('Lifecycle timed out; inspect journal before cleanup')
  }
  const owned = []
  async function inspect(owner) {
    const vm = await api('vm.inspect', { vmId: owner.id })
    if (vm.id !== owner.id || vm.name !== owner.name || vm.identity !== owner.identity)
      throw Error('VM ownership or identity changed')
    return vm
  }
  async function mutate(owner, method) {
    const vm = await inspect(owner)
    await operation(method, {
      vmId: owner.id,
      expectedRevision: vm.revision,
      ...(method === 'vm.remove' ? { deleteData: config.authorizeDeleteData === true } : {}),
    })
    const after = await inspect(owner)
    const expected = method === 'vm.remove' ? 'removed' : method === 'vm.shutdown' ? 'stopped' : 'running'
    if (after.state !== expected) throw Error('Lifecycle state mismatch')
  }
  async function verify(owner, mode) {
    await inspect(owner)
    await journal('verify-intent', { vmId: owner.id, mode })
    const result = await api('vm.verify', { vmId: owner.id, mode })
    await journal('verify-result', { vmId: owner.id, mode, ...result })
    if (
      result.ready !== true ||
      result.markerMatches !== true ||
      result.networkIsolated !== true ||
      typeof result.bootId !== 'string' ||
      !result.bootId
    )
      throw Error('Guest readiness, marker or isolation verification failed')
    return result
  }
  // Failures deliberately preserve VMs and their journals for recovery.
  for (let index = 0; index < 2; index++) {
    const name = `${config.namespace}-${randomUUID().slice(0, 8)}`
    const operationResult = await operation('vm.create', {
      name,
      imageId: config.imageId,
      runtimeId: config.runtimeId,
      ...resources,
    })
    if (typeof operationResult.vmId !== 'string') throw Error('Missing VM identifier')
    const vm = await api('vm.inspect', { vmId: operationResult.vmId })
    if (vm.id !== operationResult.vmId || vm.name !== name || typeof vm.identity !== 'string')
      throw Error('Created VM ownership mismatch')
    const owner = { id: vm.id, name, identity: vm.identity }
    await journal('owned', owner)
    owned.push(owner)
    await mutate(owner, 'vm.start')
  }
  const markers = []
  for (const owner of owned) markers.push(await verify(owner, 'write-marker'))
  // Every RPC uses a fresh, nonmultiplexed SSH process, closed before this reconnect.
  const reconnectedHost = await api('host.inspect', {})
  if (reconnectedHost.id !== host.id) throw Error('Host identity changed across SSH reconnect')
  const reconnected = await api('vm.list', {})
  for (const owner of owned)
    if (!reconnected.some((vm) => vm.id === owner.id && vm.identity === owner.identity && vm.state === 'running'))
      throw Error('Identity or concurrent running state lost across SSH reconnect')
  for (const [index, owner] of owned.entries()) {
    const reconnect = await verify(owner, 'read-marker')
    if (reconnect.bootId !== markers[index].bootId) throw Error('Unexpected reboot across SSH reconnect')
    await mutate(owner, 'vm.restart')
    const rebooted = await verify(owner, 'read-marker')
    if (rebooted.bootId === markers[index].bootId) throw Error('Guest reboot did not change boot identity')
    await mutate(owner, 'vm.shutdown')
    await mutate(owner, 'vm.start')
    const cold = await verify(owner, 'read-marker')
    if (cold.bootId === rebooted.bootId) throw Error('Cold boot did not change boot identity')
  }
  for (const owner of owned) {
    await mutate(owner, 'vm.shutdown')
    await mutate(owner, 'vm.remove')
  }
  return {
    status: 'supported',
    concurrency: 'passed',
    lifecycle: 'passed',
    guestMarker: 'passed',
    sshReconnect: 'passed',
    networkIsolated: true,
    vmIds: owned.map((vm) => vm.id),
    dataDeleted: config.authorizeDeleteData === true,
  }
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args
  if (
    !['doctor', 'transfer', 'deploy', 'install', 'smoke'].includes(command) ||
    flags.some((f) => !['--authorize-install', '--authorize-smoke'].includes(f))
  )
    throw Error('Usage: host-lab.mjs doctor|transfer|deploy|install|smoke [--authorize-install|--authorize-smoke]')
  const configPath = resolve('.maestrly-host-lab.json')
  const info = await lstat(configPath)
  if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 16384 || (info.mode & 0o077) !== 0)
    throw Error('Lab config must be a private regular file (chmod 600)')
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')))
  if (command === 'install' && (!config.authorizeInstall || !flags.includes('--authorize-install')))
    throw Error('Install requires config authorization and --authorize-install')
  if (command === 'smoke' && (!config.authorizeSmoke || !flags.includes('--authorize-smoke')))
    throw Error('Smoke requires config authorization and --authorize-smoke')
  const report = await remoteDoctor(config)
  await mkdir('.host-lab', { recursive: true, mode: 0o700 })
  const outputInfo = await lstat('.host-lab')
  if (!outputInfo.isDirectory() || outputInfo.uid !== process.getuid?.() || (outputInfo.mode & 0o077) !== 0)
    throw Error('Unsafe lab output directory')
  const runDirectory = resolve('.host-lab', `${Date.now()}-${randomUUID()}`)
  await mkdir(runDirectory, { mode: 0o700 })
  await writeFile(resolve(runDirectory, 'doctor.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  if (command === 'doctor') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.status === 'supported' ? 0 : 2
    return report
  }
  if (command === 'transfer' || command === 'deploy') {
    const result = await transfer(config, runDirectory)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = 2
    return result
  }
  if (command === 'install') {
    if (!Object.hasOwn(config, 'operator') || !config.manifestSha256)
      throw Error('Install requires manifest SHA256 and explicit operator name or null')
    const script = await readFile(new URL('../deploy/host/macos/install.sh', import.meta.url), 'utf8')
    // Every interpolated token is restricted to an allowlisted alphabet or a bounded integer.
    const args = `--authorize-install ${config.namespace} ${config.expectedIdentity} ${config.caps.cpus} ${config.caps.memoryMiB} ${config.caps.diskGiB} ${config.manifestSha256} ${config.operator ?? '--no-operator'}`
    const installedCommand = await ssh(config, `/usr/bin/sudo -n /bin/sh -s -- ${args}`, script, 120000)
    if (installedCommand.code !== 0) throw Error('Installation failed')
    const installed = await remoteDoctor(config)
    await writeFile(resolve(runDirectory, 'installed-doctor.json'), JSON.stringify(installed, null, 2), { mode: 0o600 })
    process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`)
    process.exitCode = installed.status === 'supported' ? 0 : 2
    return installed
  }
  if (report.status !== 'supported') throw Error('Smoke blocked by hardware doctor')
  const result = await smoke(config, runDirectory)
  await writeFile(resolve(runDirectory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.status === 'supported' ? 0 : 2
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    if (error?.code === 'ENOENT' && error.path === resolve('.maestrly-host-lab.json')) {
      process.stderr.write('LAB_CONFIG_MISSING: create private .maestrly-host-lab.json with the selected SSH alias, expected Host identity, namespace and authorized caps; see docs/maestrly-host-lab.md. No host was contacted.\n')
      process.exitCode = 1
      return
    }
    process.stderr.write(
      'host-lab: blocked; check explicit private config, identity, authorization, package prerequisites and saved local reports\n'
    )
    process.exitCode = 1
  })
