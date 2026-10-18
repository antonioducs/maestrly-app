import { readFileSync, statfsSync } from 'node:fs'
import os from 'node:os'
import type { FleetHostInfo } from '@maestrly/bot-fleet-protocol'
import type { GatewayConfig } from './config.js'
import type { DockerDriver } from './docker.js'

export function parseMeminfo(text: string): {
  totalBytes: number
  usedBytes: number
  swapTotalBytes: number
  swapUsedBytes: number
} {
  const values = Object.fromEntries(
    [...text.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gm)].map((match) => [
      match[1],
      Number(match[2]) * 1024,
    ])
  )
  return {
    totalBytes: values.MemTotal ?? 0,
    usedBytes: Math.max(0, (values.MemTotal ?? 0) - (values.MemAvailable ?? 0)),
    swapTotalBytes: values.SwapTotal ?? 0,
    swapUsedBytes: Math.max(0, (values.SwapTotal ?? 0) - (values.SwapFree ?? 0)),
  }
}
/** The zram devices the server swaps to, as listed in `/proc/swaps`. */
export function zramSwaps(text: string): string[] {
  return [...text.matchAll(/^\/dev\/(zram\d+)\s/gm)].map((match) => match[1])
}
/** The memory a zram device takes: `mem_used_total`, the third field of its `mm_stat`; null when unreadable. */
export function parseZramMemory(text: string): number | null {
  const value = Number(text.trim().split(/\s+/)[2])
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
/**
 * The memory compressed swap takes on a Linux server. Swapped pages leave their container's count, but zram keeps them
 * in memory, compressed, charged to no container: without this, they would show as the system's.
 */
function compressedSwapBytes(): number {
  let total = 0
  try {
    for (const device of zramSwaps(readFileSync('/proc/swaps', 'utf8')))
      try {
        total += parseZramMemory(readFileSync('/sys/block/' + device + '/mm_stat', 'utf8')) ?? 0
      } catch {}
  } catch {}
  return total
}
export function parseProcStat(text: string): { idle: number; total: number } {
  const line = text.split('\n').find((line) => line.startsWith('cpu ')) ?? ''
  const values = line.trim().split(/\s+/).slice(1).map(Number)
  return {
    idle: (values[3] ?? 0) + (values[4] ?? 0),
    total: values.reduce((sum, value) => sum + value, 0),
  }
}
export function cpuPercent(
  before: { idle: number; total: number },
  after: { idle: number; total: number }
): number | null {
  const total = after.total - before.total
  return total > 0 ? Math.max(0, Math.min(100, (1 - (after.idle - before.idle) / total) * 100)) : null
}
export function getGatewayVersion(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.MAESTRLY_GATEWAY_VERSION?.trim() ||
    (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
  )
}
export class HostMonitor {
  private previous: { idle: number; total: number } | null = null
  constructor(
    readonly config: GatewayConfig,
    readonly docker: DockerDriver,
    readonly gatewayVersion = getGatewayVersion()
  ) {}
  async botImageVersion(): Promise<string | null> {
    try {
      return (await this.docker.imageInspect(this.config.botImage))?.version ?? null
    } catch {
      return null
    }
  }
  async read(botsBytes = 0): Promise<FleetHostInfo> {
    const mem =
      process.platform === 'linux'
        ? parseMeminfo(readFileSync('/proc/meminfo', 'utf8'))
        : {
            totalBytes: os.totalmem(),
            usedBytes: os.totalmem() - os.freemem(),
            swapTotalBytes: null,
            swapUsedBytes: null,
          }
    const current =
      process.platform === 'linux' ? parseProcStat(readFileSync('/proc/stat', 'utf8')) : { idle: 0, total: 0 }
    const cpu = this.previous ? cpuPercent(this.previous, current) : null
    this.previous = current
    const fs = statfsSync(this.config.dataDir)
    const release =
      process.platform === 'linux'
        ? (readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?(.*?)"?$/m)?.[1] ?? os.type())
        : os.type()
    let dockerVersion: null | string = null
    try {
      dockerVersion = await this.docker.version()
    } catch {}
    return {
      hostname: this.config.displayName ?? os.hostname(),
      os: release,
      kernel: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      cpuPercent: cpu,
      memory: {
        totalBytes: mem.totalBytes,
        usedBytes: mem.usedBytes,
        botsBytes,
        swap:
          mem.swapTotalBytes === null
            ? null
            : { totalBytes: mem.swapTotalBytes, usedBytes: mem.swapUsedBytes, compressedBytes: compressedSwapBytes() },
      },
      disk: {
        totalBytes: fs.blocks * fs.bsize,
        usedBytes: (fs.blocks - fs.bfree) * fs.bsize,
      },
      uptimeSeconds: os.uptime(),
      gatewayVersion: this.gatewayVersion,
      botImage: this.config.botImage,
      botImageVersion: await this.botImageVersion(),
      dockerVersion,
    }
  }
}
