import {
  FLEET_RUNNER_LIMITS,
  FLEET_RUNNER_PROTOCOL_VERSION,
  type FleetRunnerCapabilities,
} from '@maestrly/bot-fleet-protocol'
import { execFile } from 'node:child_process'
import os from 'node:os'

export type CapabilityExec = (file: string, args: string[]) => Promise<string>

const PROBE_TIMEOUT_MS = 5_000
const MIB = 1024 * 1024

const execText: CapabilityExec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })

const runnerOs = (platform: NodeJS.Platform): FleetRunnerCapabilities['os'] =>
  platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'

type Gpu = FleetRunnerCapabilities['gpu']

/** The first GPU `nvidia-smi` lists, as `name, memory in MiB` per line. */
async function nvidiaGpu(exec: CapabilityExec): Promise<Gpu> {
  const out = await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  const line = out.split(/\r?\n/).find((candidate) => candidate.trim())
  if (!line) return null
  const comma = line.lastIndexOf(',')
  const name = (comma < 0 ? line : line.slice(0, comma)).trim().slice(0, 200)
  if (!name) return null
  const mebibytes = comma < 0 ? Number.NaN : Number.parseInt(line.slice(comma + 1), 10)
  return { vendor: 'nvidia', name, memoryBytes: mebibytes > 0 ? mebibytes * MIB : null }
}

/** Apple silicon's chip, named by the CPU brand: the GPU shares the computer's memory. */
async function appleGpu(exec: CapabilityExec): Promise<Gpu> {
  const brand = (await exec('sysctl', ['-n', 'machdep.cpu.brand_string'])).trim()
  return brand.startsWith('Apple') ? { vendor: 'apple', name: brand.slice(0, 200), memoryBytes: null } : null
}

/**
 * What this computer tells the gateway about itself: the job protocol it speaks, OS, architecture, logical CPUs,
 * memory, the executor and slots it was configured with, and a GPU when `nvidia-smi` lists one or the Mac has Apple
 * silicon. A probe that fails means no GPU.
 */
export async function probeRunnerCapabilities(options: {
  executor: FleetRunnerCapabilities['executor']
  slots: number
  platform?: NodeJS.Platform
  arch?: string
  exec?: CapabilityExec
}): Promise<FleetRunnerCapabilities> {
  const platform = options.platform ?? process.platform
  const exec = options.exec ?? execText
  let gpu: Gpu = null
  if (platform !== 'darwin') gpu = await nvidiaGpu(exec).catch(() => null)
  else gpu = await appleGpu(exec).catch(() => null)
  return {
    protocol: FLEET_RUNNER_PROTOCOL_VERSION,
    os: runnerOs(platform),
    arch: (options.arch ?? process.arch) === 'arm64' ? 'arm64' : 'x64',
    cpus: Math.min(4096, Math.max(1, os.availableParallelism())),
    memoryBytes: Math.max(1, os.totalmem()),
    executor: options.executor,
    gpu,
    slots: Math.min(FLEET_RUNNER_LIMITS.slotsMax, Math.max(1, Math.trunc(options.slots))),
  }
}
