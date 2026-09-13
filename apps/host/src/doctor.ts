import { inspectService } from './client.js'
import { execFile } from 'node:child_process'
import { lstat, statfs } from 'node:fs/promises'
import { totalmem } from 'node:os'
export interface DoctorFacts {
  platform: string
  processArch: string
  physicalArch: string | null
  translated: boolean | null
  model: string | null
  macOS: string | null
  identity: string | null
  memoryMiB: number | null
  freeDiskGiB: number | null
  physicalCpus: number | null
  fileVault: boolean | null
  sleepMinutes: number | null
  runtimeSmoke: boolean | null
  hvf: boolean | null
}
export function assessDoctor(facts: DoctorFacts) {
  const checks: Array<{ name: string; status: 'supported' | 'blocked' | 'needs_action'; message: string }> = []
  const check = (name: string, value: boolean | null, message: string) =>
    checks.push({ name, status: value === null ? 'needs_action' : value ? 'supported' : 'blocked', message })
  check('platform', facts.platform === 'darwin', 'Requires macOS')
  check(
    'physical_arch',
    facts.physicalArch === null ? null : ['arm64', 'x86_64'].includes(facts.physicalArch),
    'Requires measured Apple Silicon or Intel architecture'
  )
  check('native_process', facts.translated === null ? null : !facts.translated, 'Rosetta execution is unsupported')
  check(
    'physical_mac',
    facts.model === null ? null : /^(Mac\d|MacBook|Macmini|MacPro|MacStudio|iMac|Xserve)/.test(facts.model),
    'Requires a recognized physical Mac model; virtual or unrecognized models are blocked'
  )
  check(
    'macos_version',
    facts.macOS === null ? null : Number(facts.macOS.split('.')[0]) >= 13,
    'Phase 1 requires macOS 13 or newer'
  )
  check(
    'physical_cpus',
    facts.physicalCpus === null ? null : facts.physicalCpus >= 1,
    'Requires measured physical CPU count'
  )
  check(
    'runtime_smoke',
    facts.runtimeSmoke,
    'Requires service QEMU runtime smoke; helper capability alone is insufficient'
  )
  check('identity', facts.identity === null ? null : /^[0-9a-f-]{36}$/i.test(facts.identity), 'Requires IOPlatformUUID')
  check(
    'memory',
    facts.memoryMiB === null ? null : facts.memoryMiB >= 4096,
    'Requires at least 4096 MiB physical memory'
  )
  check(
    'disk',
    facts.freeDiskGiB === null ? null : facts.freeDiskGiB >= 20,
    'Requires at least 20 GiB available on the state volume'
  )
  check(
    'hvf',
    facts.hvf,
    'Requires successful signed Hypervisor.framework VM create/destroy smoke under the current identity'
  )
  return {
    version: 1,
    status: checks.some((c) => c.status === 'blocked')
      ? 'blocked'
      : checks.some((c) => c.status === 'needs_action')
        ? 'needs_action'
        : 'supported',
    facts,
    checks,
  }
}
function probe(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(
      file,
      args,
      { timeout: 10000, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
      (error, stdout) => resolve(error ? null : stdout.trim())
    )
  )
}
export async function doctor(stateDirectory = '/Library') {
  const facts: DoctorFacts = {
    platform: process.platform,
    processArch: process.arch,
    physicalArch: null,
    translated: null,
    model: null,
    macOS: null,
    identity: null,
    memoryMiB: Math.floor(totalmem() / 1048576),
    freeDiskGiB: null,
    hvf: null,
    physicalCpus: null,
    fileVault: null,
    sleepMinutes: null,
    runtimeSmoke: null,
  }
  try {
    const disk = await statfs(stateDirectory)
    facts.freeDiskGiB = Math.floor((disk.bavail * disk.bsize) / 1073741824)
  } catch {
    /* Missing installation needs action. */
  }
  if (process.platform === 'darwin') {
    const [arm, machine, translated, model, version, registry, physicalCpus, fileVault, power] = await Promise.all([
      probe('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']),
      probe('/usr/sbin/sysctl', ['-n', 'hw.machine']),
      probe('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated']),
      probe('/usr/sbin/sysctl', ['-n', 'hw.model']),
      probe('/usr/bin/sw_vers', ['-productVersion']),
      probe('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']),
      probe('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu']),
      probe('/usr/bin/fdesetup', ['status']),
      probe('/usr/bin/pmset', ['-g', 'custom']),
    ])
    facts.physicalArch = arm === '1' ? 'arm64' : machine === 'x86_64' ? 'x86_64' : null
    facts.translated =
      translated === '1'
        ? true
        : translated === '0' || process.arch === 'arm64' || facts.physicalArch === 'x86_64'
          ? false
          : null
    facts.physicalCpus = physicalCpus && /^\d+$/.test(physicalCpus) ? Number(physicalCpus) : null
    facts.fileVault = fileVault === 'FileVault is On.' ? true : fileVault === 'FileVault is Off.' ? false : null
    const sleeps = [...(power ?? '').matchAll(/^\s*sleep\s+(\d+)/gm)].map((match) => Number(match[1]))
    facts.sleepMinutes = sleeps.length ? Math.max(...sleeps) : null
    facts.model = model?.match(/^[A-Za-z0-9,._-]+$/)?.[0] ?? null
    facts.macOS = version?.match(/^[0-9.]+$/)?.[0] ?? null
    facts.identity = registry?.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/)?.[1] ?? null
    const helper = '/Library/MaestrlyHost/bin/hvf-smoke'
    try {
      const info = await lstat(helper)
      if (info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0)
        facts.hvf = (await probe(helper, [])) === 'MAESTRLY_HVF_OK'
    } catch {
      /* Explicitly unverified. */
    }
  }
  let service = null
  try {
    service = await inspectService()
    facts.runtimeSmoke = service.capabilities.includes('runtime.hvf-smoke')
      ? service.supported && service.runtimes.some((runtime) => runtime.available)
      : null
  } catch {
    /* No service evidence: never claim runtime support. */
  }
  return {
    ...assessDoctor(facts),
    capabilities: { hvfHelper: facts.hvf, qemuRuntimeSmoke: facts.runtimeSmoke },
    service,
    conditions: {
      fileVault:
        facts.fileVault === true
          ? 'Local unlock may be required after physical reboot'
          : facts.fileVault === false
            ? 'off'
            : 'unavailable',
      sleep:
        facts.sleepMinutes === 0
          ? 'disabled'
          : facts.sleepMinutes === null
            ? 'unavailable'
            : 'Automatic sleep may interrupt guests',
    },
  }
}
