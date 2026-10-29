import type { FleetRunnerCapabilities } from '@maestrly/bot-fleet-protocol'

/** A Mac that runs jobs natively, one at a time, with its Apple GPU. */
export const studio: FleetRunnerCapabilities = {
  protocol: 1,
  os: 'macos',
  arch: 'arm64',
  cpus: 12,
  memoryBytes: 36 * 1024 ** 3,
  executor: 'native',
  gpu: { vendor: 'apple', name: 'Apple M3 Pro', memoryBytes: null },
  slots: 1,
}
/** A Linux tower that runs two jobs at a time in containers, with an NVIDIA GPU. */
export const gpuPc: FleetRunnerCapabilities = {
  ...studio,
  os: 'linux',
  arch: 'x64',
  executor: 'container',
  gpu: { vendor: 'nvidia', name: 'RTX 4090', memoryBytes: 24 * 1024 ** 3 },
  slots: 2,
}
