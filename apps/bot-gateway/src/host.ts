import { readFileSync, statfsSync } from 'node:fs'
import os from 'node:os'
import type { FleetHostInfo } from '@maestrly/bot-fleet-protocol'
import type { GatewayConfig } from './config.js'
import type { DockerDriver } from './docker.js'

export function parseMeminfo(text: string): { totalBytes: number; usedBytes: number } {
  const values = Object.fromEntries(
    [...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)].map((match) => [match[1], Number(match[2]) * 1024])
  )
  return {
    totalBytes: values.MemTotal ?? 0,
    usedBytes: Math.max(0, (values.MemTotal ?? 0) - (values.MemAvailable ?? 0)),
  }
}
export function parseProcStat(text: string): { idle: number; total: number } {
  const line = text.split('\n').find((line) => line.startsWith('cpu ')) ?? ''
  const values = line.trim().split(/\s+/).slice(1).map(Number)
  return { idle: (values[3] ?? 0) + (values[4] ?? 0), total: values.reduce((sum, value) => sum + value, 0) }
}
export function cpuPercent(
  before: { idle: number; total: number },
  after: { idle: number; total: number }
): number | null {
  const total = after.total - before.total
  return total > 0 ? Math.max(0, Math.min(100, (1 - (after.idle - before.idle) / total) * 100)) : null
}
export class HostMonitor {
  private previous: { idle: number; total: number } | null = null
  constructor(
    readonly config: GatewayConfig,
    readonly docker: DockerDriver,
    readonly gatewayVersion = '0.1.0'
  ) {}
  async read(botsBytes = 0): Promise<FleetHostInfo> {
    const mem =
      process.platform === 'linux'
        ? parseMeminfo(readFileSync('/proc/meminfo', 'utf8'))
        : { totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem() }
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
      hostname: os.hostname(),
      os: release,
      kernel: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      cpuPercent: cpu,
      memory: { totalBytes: mem.totalBytes, usedBytes: mem.usedBytes, botsBytes },
      disk: { totalBytes: fs.blocks * fs.bsize, usedBytes: (fs.blocks - fs.bfree) * fs.bsize },
      uptimeSeconds: os.uptime(),
      gatewayVersion: this.gatewayVersion,
      botImage: this.config.botImage,
      botImageVersion: null,
      dockerVersion,
    }
  }
}
