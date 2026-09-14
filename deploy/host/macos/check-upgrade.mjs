// Preserving upgrade preflight for an installed Maestrly Host. Pure decision logic is exported
// for tests; the CLI gathers facts from the fixed installation paths only.
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { sha256 } from './verify-package.mjs'
import { assertPackageCompatibility } from './check-compatibility.mjs'
export const INSTALL_ROOT = '/Library/MaestrlyHost'
/**
 * Refuses an upgrade when: the installation is missing/untrusted, a bot setup or turn is active,
 * quotas would shrink below current reservations, the package is older than the installed one,
 * a hypervisor swap is requested while guests run, or no consistent backup window is authorized.
 */
export function assessUpgrade(input) {
  const blockers = []
  const { installed, candidate, activity, authorization } = input
  const measuredCounts = (value, keys) => keys.every((key) => Number.isSafeInteger(value?.[key]) && value[key] >= 0)
  if (!measuredCounts(activity, ['activeSetups', 'activeTurns', 'runningVms']))
    blockers.push('ACTIVITY_UNKNOWN: live setup, turn and VM activity must be measured before upgrading')
  if (!measuredCounts(installed?.reserved, ['cpus', 'memoryMiB', 'diskGiB']))
    blockers.push('RESERVATIONS_UNKNOWN: current VM reservations must be measured before upgrading')
  if (!Array.isArray(installed?.referencedImageIds) || !installed.referencedImageIds.every((id) => typeof id === 'string' && id.length > 0))
    blockers.push('IMAGE_REFERENCES_UNKNOWN: current VM image references must be measured before upgrading')
  if (!installed || installed.owner !== 'root' || installed.worldWritable) blockers.push('INSTALL_UNTRUSTED: /Library/MaestrlyHost must exist, be root-owned and not writable by others')
  if (!candidate?.manifest || candidate.manifest.version !== 1) blockers.push('PACKAGE_MANIFEST: a verified version 1 manifest is required')
  if (installed && candidate?.manifest && compare(candidate.manifest.serviceVersion ?? '0.0.0', installed.serviceVersion ?? '0.0.0') < 0)
    blockers.push('PACKAGE_DOWNGRADE: the candidate is older than the installed service; downgrades need an explicit restore procedure')
  if (installed?.config && candidate?.config) {
    for (const key of ['cpus', 'memoryMiB', 'diskGiB'])
      if (candidate.config.capacity?.[key] !== undefined && candidate.config.capacity[key] < (installed.reserved?.[key] ?? 0))
        blockers.push(`QUOTA_BELOW_RESERVATION: ${key} quota would drop below what existing VMs reserve`)
    if (candidate.config.stateDirectory && candidate.config.stateDirectory !== installed.config.stateDirectory) blockers.push('STATE_DIRECTORY_CHANGED: the state directory is fixed')
    for (const image of installed.config.images ?? [])
      if (installed.referencedImageIds?.includes(image.id) && !(candidate.config.images ?? []).some((c) => c.id === image.id))
        blockers.push(`IMAGE_REFERENCED: image ${image.id} is used by existing VMs and must stay in the catalogue`)
  }
  if (activity?.activeSetups > 0) blockers.push('BOT_SETUP_ACTIVE: finish or cancel bot preparation before upgrading')
  if (activity?.activeTurns > 0) blockers.push('BOT_TURN_ACTIVE: stop running tasks before upgrading')
  if (activity?.runningVms > 0 && candidate?.replacesRuntime) blockers.push('RUNTIME_IN_USE: replacing QEMU requires an authorized guest shutdown window')
  if (!authorization?.window) blockers.push('WINDOW_REQUIRED: an authorized maintenance window is required')
  if (!authorization?.backup) blockers.push('BACKUP_REQUIRED: a consistent SQLite backup (including WAL) must be authorized')
  return { status: blockers.length ? 'blocked' : 'ready', blockers }
}
export function compare(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta) return delta
  }
  return 0
}
// Fixed installed client; no shell, bounded execution and bounded output.
export function liveRpc(method, params = {}, run = spawnSync) {
  const id = 'upgrade-preflight'
  const reply = run(`${INSTALL_ROOT}/bin/maestrly-host`, ['rpc-stdio'], {
    input: JSON.stringify({ version: 1, id, method, params }) + '\n',
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  })
  if (reply.error || reply.signal || reply.status !== 0) throw Error(`RPC_UNAVAILABLE: ${method}`)
  let value
  try { value = JSON.parse(reply.stdout) } catch { throw Error(`RPC_INVALID: ${method}`) }
  if (!value || value.version !== 1 || value.id !== id ||
      Object.keys(value).some(key => !['version', 'id', 'result', 'error'].includes(key)) ||
      !Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error')) throw Error(`RPC_INVALID: ${method}`)
  return value.result
}
const requireFact = (condition, label) => { if (!condition) throw Error(`LIVE_EVIDENCE_INVALID: ${label}`) }
const count = value => Number.isSafeInteger(value) && value >= 0
export function collectLiveFacts(request = liveRpc) {
  const deadline = Date.now() + 60000
  const rpc = (method, params) => {
    if (Date.now() > deadline) throw Error('RPC_TIMEOUT: collection exceeded one minute')
    return request(method, params)
  }
  const host = rpc('host.inspect', {})
  requireFact(host?.protocolVersion === 1 && typeof host.serviceVersion === 'string' &&
    Array.isArray(host.capabilities) && host.capabilities.every(c => typeof c === 'string'), 'host')
  requireFact(['cpus', 'memoryMiB', 'diskGiB'].every(k => count(host.allocated?.[k])), 'allocated')
  const vms = rpc('vm.list', { includeRetained: true })
  requireFact(Array.isArray(vms), 'VM list')
  requireFact(vms.length <= 10000, 'VM inventory limit')
  const ids = new Set()
  for (const vm of vms) {
    requireFact(vm && typeof vm.id === 'string' && !ids.has(vm.id) && typeof vm.imageId === 'string' && vm.imageId.length > 0 &&
      ['stopped', 'starting', 'running', 'stopping', 'unknown', 'removed'].includes(vm.state) &&
      ['cpus', 'memoryMiB', 'diskGiB'].every(k => count(vm[k]) && vm[k] > 0), 'VM')
    ids.add(vm.id)
  }
  const activity = { activeSetups: 0, activeTurns: 0, runningVms: vms.filter(v => !['stopped', 'removed'].includes(v.state)).length }
  // Bot feature v2 still uses the v1 wire envelope. A legacy Host advertises no bot capability.
  if (host.capabilities.some(c => c.startsWith('bot.'))) {
    requireFact(host.capabilities.includes('bot.runtime.v1'), 'unsupported bot capability')
    const bots = rpc('bot.list', { includeArchived: true })
    requireFact(Array.isArray(bots), 'bot list')
    requireFact(bots.length <= 100, 'bot inventory limit')
    const botIds = new Set()
    for (const bot of bots) {
      requireFact(bot && typeof bot.id === 'string' && !botIds.has(bot.id) &&
        ['setup', 'ready', 'needs_attention', 'archived'].includes(bot.status), 'bot')
      botIds.add(bot.id)
      if (bot.status === 'setup' || bot.runtimeState === 'preparing') activity.activeSetups++
      for (const [key, method, param, statuses, terminal, field] of [
        ['setupOperationId', 'bot.setup.inspect', 'operationId', ['queued', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled'], ['succeeded', 'failed', 'cancelled'], 'activeSetups'],
        ['activeTurnId', 'bot.turn.get', 'turnId', ['queued', 'starting', 'running', 'waiting_approval', 'waiting_input', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'needs_attention'], ['succeeded', 'failed', 'cancelled', 'interrupted'], 'activeTurns'],
      ]) {
        if (bot[key] === undefined) continue
        requireFact(typeof bot[key] === 'string' && bot[key].length > 0, key)
        const work = rpc(method, { [param]: bot[key] })
        requireFact(work?.id === bot[key] && (work.botId === bot.id || (param === 'operationId' && work.botId === undefined)) && statuses.includes(work.status), method)
        if (!terminal.includes(work.status)) activity[field]++
      }
    }
  }
  return { serviceVersion: host.serviceVersion, reserved: host.allocated,
    referencedImageIds: [...new Set(vms.map(v => v.imageId))], activity, vms }
}
// Installation manifests describe retained bytes, not the candidate's factory defaults.
export async function installationManifest(base, stage) {
  const installed = JSON.parse(await readFile(`${base}/manifest.json`, 'utf8'))
  const candidate = JSON.parse(await readFile(`${stage}/manifest.json`, 'utf8'))
  const candidatePaths = new Set(candidate.files.map(f => f.path))
  const replaced = path => path.startsWith('app/') || (/^(bin|install)\//.test(path) && candidatePaths.has(path))
  const validate = manifest => {
    const paths = new Set()
    for (const f of manifest.files) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(f.path) || f.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256)) throw Error('Invalid installation manifest entry')
      paths.add(f.path)
    }
  }
  validate(installed); validate(candidate)
  const retained = []
  for (const f of installed.files) {
    if (replaced(f.path)) continue
    const info = await lstat(`${base}/${f.path}`)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022)) throw Error(`Unsafe retained artifact: ${f.path}`)
    const actual = await sha256(`${base}/${f.path}`)
    // host.json is operator configuration, captured explicitly in installation provenance.
    if (f.path !== 'etc/host.json' && actual !== f.sha256) throw Error(`Retained artifact drift: ${f.path}`)
    retained.push({ ...f, sha256: actual })
  }
  const next = { ...candidate, files: [...retained, ...candidate.files.filter(f => replaced(f.path))].sort((a, b) => a.path.localeCompare(b.path)) }
  for (const key of ['architecture', 'nodeVersion', 'qemuVersion', 'firmware', 'firmwareVars', 'sources']) {
    if (Object.hasOwn(installed, key)) next[key] = installed[key]
    else delete next[key]
  }
  next.installation = { previousManifestSha256: await sha256(`${base}/manifest.json`), candidateManifestSha256: await sha256(`${stage}/manifest.json`), retainedPaths: retained.map(f => f.path) }
  return next
}
async function main() {
  const [candidateDirectory, action, output] = process.argv.slice(2)
  if (action === '--manifest') {
    if (!output) throw Error('Manifest output required')
    await writeFile(output, JSON.stringify(await installationManifest(INSTALL_ROOT, candidateDirectory), null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return
  }
  if (!candidateDirectory) throw new Error('Expected the verified candidate package directory')
  const root = await lstat(INSTALL_ROOT)
  for (const entry of ['', '/etc', '/etc/host.json', '/manifest.json', '/bin', '/bin/maestrly-host', '/app', '/app/cli.mjs', '/runtime', '/runtime/bin', '/runtime/bin/node']) {
    const info = await lstat(INSTALL_ROOT + entry)
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw Error('INSTALL_UNTRUSTED: ' + entry)
  }
  const installedConfig = JSON.parse(await readFile(`${INSTALL_ROOT}/etc/host.json`, 'utf8'))
  const candidateManifest = JSON.parse(await readFile(resolve(candidateDirectory, 'manifest.json'), 'utf8'))
  const macOS = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
  assertPackageCompatibility(candidateManifest, { platform: process.platform, arch: process.arch, physicalArch: process.arch, macOS, nodeVersion: process.versions.node })
  const facts = collectLiveFacts()
  if (installedConfig.stateDirectory !== `${INSTALL_ROOT}/state`) throw Error('STATE_DIRECTORY_CHANGED: unsupported installed state path')
  const installedNodeVersion = execFileSync(`${INSTALL_ROOT}/runtime/bin/node`, ['--version'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 }).trim().replace(/^v/, '')
  if (candidateManifest.nodeVersion !== installedNodeVersion) throw Error('NODE_RUNTIME_CHANGED: preserving upgrade requires the installed Node version; use a separately reviewed runtime migration')
  const result = assessUpgrade({
    installed: { owner: root.uid === 0 ? 'root' : 'other', worldWritable: (root.mode & 0o022) !== 0, serviceVersion: facts.serviceVersion, config: installedConfig, reserved: facts.reserved, referencedImageIds: facts.referencedImageIds },
    candidate: { manifest: candidateManifest, config: installedConfig, replacesRuntime: false },
    activity: facts.activity,
    authorization: { window: process.env.MAESTRLY_UPGRADE_WINDOW === '1', backup: process.env.MAESTRLY_UPGRADE_BACKUP === '1' },
  })
  if (facts.activity.runningVms > 0) { result.blockers.push('GUEST_SHUTDOWN_REQUIRED: shut down guests for the offline state backup'); result.status = 'blocked' }
  process.stdout.write(`${JSON.stringify({ ...result, facts })}\n`)
  process.exitCode = result.status === 'ready' ? 0 : 2
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
