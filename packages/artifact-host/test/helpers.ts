import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** A temporary directory removed by the returned cleanup. */
export function tempDir(prefix = 'artifact-host-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
export const text = (bytes: Uint8Array | null | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array())

/** A controllable clock for expiry tests. */
export function testClock(start = 1_800_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms) => (current += ms) }
}
