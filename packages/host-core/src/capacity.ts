import { cpus, totalmem, freemem } from 'node:os'
import { statfsSync } from 'node:fs'
export const diskSafetyBytes = 2 * 1024 ** 3
export function usableCapacity(directory: string) {
  const space = statfsSync(directory)
  return {
    cpus: Math.max(1, cpus().length - 1),
    memoryMiB: Math.floor(Math.max(0, totalmem() - Math.max(2 * 1024 ** 3, totalmem() * 0.25)) / 1024 ** 2),
    diskGiB: Math.floor(Math.max(0, space.bavail * space.bsize - diskSafetyBytes) / 1024 ** 3),
  }
}
export const observedMemoryMiB = () => Math.floor((totalmem() - freemem()) / 1024 ** 2)
