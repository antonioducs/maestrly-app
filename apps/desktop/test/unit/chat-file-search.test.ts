import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { searchFiles } from '../../src/main/chat/file-search'

/** File search for '@' autocomplete: scan cwd, skip .git/node_modules, prioritize names. */
let dir = ''

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'chat-fs-'))
  mkdirSync(path.join(dir, 'src', 'cargo'), { recursive: true })
  mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(path.join(dir, 'src', 'cargo', 'store.ts'), '')
  writeFileSync(path.join(dir, 'src', 'cargo', 'types.ts'), '')
  writeFileSync(path.join(dir, 'src', 'useCargo.ts'), '')
  writeFileSync(path.join(dir, 'README.md'), '')
  mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true })
  mkdirSync(path.join(dir, '.vscode'), { recursive: true })
  writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.ts'), '') // must be ignored
  writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), '')
  writeFileSync(path.join(dir, '.vscode', 'settings.json'), '')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('searchFiles (@ autocomplete)', () => {
  it('finds files by name', async () => {
    const hits = await searchFiles(dir, 'store')
    expect(hits.map((h) => h.path)).toContain('src/cargo/store.ts')
  })

  it('finds files by partial path', async () => {
    const hits = await searchFiles(dir, 'cargo')
    const paths = hits.map((h) => h.path)
    expect(paths).toContain('src/cargo/store.ts')
    expect(paths).toContain('src/cargo/types.ts')
    expect(paths).toContain('src/useCargo.ts')
  })

  it('ignores node_modules', async () => {
    const hits = await searchFiles(dir, 'index')
    expect(hits.find((h) => h.path.includes('node_modules'))).toBeUndefined()
  })

  it('includes useful dot directories such as .github and .vscode', async () => {
    const hits = await searchFiles(dir, 'github')
    expect(hits.map((h) => h.path)).toContain('.github/')
    expect(hits.map((h) => h.path)).toContain('.github/workflows/ci.yml')
    const vs = await searchFiles(dir, 'vscode')
    expect(vs.map((h) => h.path)).toContain('.vscode/')
  })

  it('lists project files for an empty query, excluding node_modules', async () => {
    const hits = await searchFiles(dir, '')
    const paths = hits.map((h) => h.path)
    expect(paths).toContain('README.md')
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it('prioritizes name matches over path matches', async () => {
    const hits = await searchFiles(dir, 'cargo')
    // useCargo.ts matches by name and must precede store.ts, which matches only by path.
    const iUse = hits.findIndex((h) => h.path === 'src/useCargo.ts')
    const iStore = hits.findIndex((h) => h.path === 'src/cargo/store.ts')
    expect(iUse).toBeGreaterThanOrEqual(0)
    expect(iUse).toBeLessThan(iStore)
  })

  it('includes directories with kind:dir and a trailing slash', async () => {
    const hits = await searchFiles(dir, 'cargo')
    const dirHit = hits.find((h) => h.kind === 'dir' && h.path === 'src/cargo/')
    expect(dirHit).toBeDefined()
    expect(dirHit?.name).toBe('cargo')
  })

  it('marks files with kind:file', async () => {
    const hits = await searchFiles(dir, 'store')
    const fileHit = hits.find((h) => h.path === 'src/cargo/store.ts')
    expect(fileHit?.kind).toBe('file')
  })
})
