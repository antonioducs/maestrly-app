import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBundleDirectory } from '../src/directory.js'
import { ArtifactHostError } from '../src/errors.js'
import { tempDir, text } from './helpers.js'

let dir: string
let cleanup: () => void

beforeEach(() => {
  ;({ dir, cleanup } = tempDir())
})
afterEach(() => cleanup())

function put(relative: string, content = 'x'): void {
  mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
  writeFileSync(path.join(dir, relative), content)
}

async function errorOf(promise: Promise<unknown>): Promise<ArtifactHostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ArtifactHostError) return error
    throw error
  }
  throw new Error('expected an error')
}

describe('readBundleDirectory', () => {
  it('reads publishable files and skips hidden folders, dependencies and unknown types', async () => {
    put('index.html', '<p>hi</p>')
    put('css/a.css', 'p{}')
    put('.hidden/x.txt')
    put('node_modules/y.js')
    put('app.js.map')
    const result = await readBundleDirectory(dir)
    expect(result.files.map((f) => f.path)).toEqual(['css/a.css', 'index.html'])
    expect(text(result.files.find((f) => f.path === 'index.html')?.bytes)).toBe('<p>hi</p>')
    expect(result.skipped).toEqual(['app.js.map'])
  })

  it.skipIf(process.platform === 'win32')('refuses symbolic links', async () => {
    put('index.html')
    symlinkSync(path.join(dir, 'index.html'), path.join(dir, 'link.html'))
    const error = await errorOf(readBundleDirectory(dir))
    expect(error.code).toBe('invalid_path')
    expect(error.message).toContain('Symbolic links')
  })

  it('stops at the file limit', async () => {
    for (let i = 0; i < 501; i += 1) put(`f${i}.txt`)
    expect((await errorOf(readBundleDirectory(dir))).code).toBe('too_many_files')
  })

  it('reports a missing directory', async () => {
    expect((await errorOf(readBundleDirectory(path.join(dir, 'missing')))).code).toBe('not_found')
  })
})
