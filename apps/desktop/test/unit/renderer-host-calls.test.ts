/**
 * A conversation or workspace belongs to a host, so the renderer reaches a host's backend through
 * `useHostApi()` / `hostApi(hostId)`, never through `window.api`, which is this computer's app and window only.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeHostApi } from '../../src/preload/host-api'

const root = fileURLToPath(new URL('../../src/renderer', import.meta.url))
const noop = { invoke: async () => undefined, send: () => {}, on: () => {}, removeListener: () => {} }
const hostMembers = new Set(Object.keys(makeHostApi(noop)))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}
describe('renderer reaches host members only through its host', () => {
  it('has no window.api host calls', () => {
    const violations: string[] = []
    const files = sourceFiles(root)
    expect(files.length).toBeGreaterThan(100)
    for (const path of files) {
      const file = relative(root, path).split(sep).join('/')
      // `\s*`: a long call chain puts the member on the line after `window.api`.
      for (const match of readFileSync(path, 'utf8').matchAll(/window\.api\s*\.([A-Za-z0-9_]+)/g))
        if (hostMembers.has(match[1])) violations.push(`${file}: ${match[1]}`)
    }
    expect(violations).toEqual([])
  })
})
