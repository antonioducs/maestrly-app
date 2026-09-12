import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Artifact store for GENERATED images (Codex imagegen). Core invariant: bytes live in
 * app-owned file under userData; only opaque handles cross DB and IPC, never paths
 * from the renderer, with no base64 in parts_json.
 */
const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))

const {
  MAX_GENERATED_IMAGE_BYTES,
  decodeGeneratedImage,
  deleteConversationGeneratedImages,
  deleteGeneratedImages,
  materializeGeneratedImage,
  readGeneratedImage,
  resolveGeneratedImageOutputTarget,
  saveGeneratedImage,
} = await import('../../src/main/chat/generated-images')

/** Real 1x1 PNG with valid signature; unknown image signatures are rejected. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const root = (): string => path.join(h.userData, 'chat-generated-images')

beforeEach(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'maestrly-genimg-'))
})
afterEach(() => {
  rmSync(h.userData, { recursive: true, force: true })
})

describe('decodeGeneratedImage', () => {
  it('detects image formats in base64 and data URLs', () => {
    const plain = decodeGeneratedImage(PNG_1X1_BASE64)
    expect(plain.mime).toBe('image/png')
    expect(plain.ext).toBe('png')
    expect(plain.buffer.length).toBeGreaterThan(0)

    const dataUrl = decodeGeneratedImage(`data:image/png;base64,${PNG_1X1_BASE64}`)
    expect(dataUrl.mime).toBe('image/png')
    expect(dataUrl.buffer.equals(plain.buffer)).toBe(true)
  })

  it('rejects empty results, invalid base64 and unsupported formats', () => {
    expect(() => decodeGeneratedImage('')).toThrow(/empty/i)
    expect(() => decodeGeneratedImage('   ')).toThrow(/empty/i)
    expect(() => decodeGeneratedImage('not base64 !!!')).toThrow(/base64/i)
    // Valid base64 containing non-image bytes.
    expect(() => decodeGeneratedImage(Buffer.from('hello world').toString('base64'))).toThrow(/supported image/i)
  })

  it('rejects oversized payloads', () => {
    const huge = Buffer.alloc(MAX_GENERATED_IMAGE_BYTES + 1024, 0x41).toString('base64')
    expect(() => decodeGeneratedImage(huge)).toThrow(/exceeds/i)
  })
})

describe('saveGeneratedImage', () => {
  it('stores artifacts under the conversation and returns opaque handles without temporary files', async () => {
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64, label: 'a cat' })

    expect(stored.artifactId).toMatch(/^[a-f0-9]{32}$/)
    expect(stored.mediaType).toBe('image/png')
    expect(stored.name).toBe('a-cat.png')
    expect(stored.byteSize).toBeGreaterThan(0)

    const files = readdirSync(path.join(root(), 'conv1'))
    expect(files).toEqual([`${stored.artifactId}.png`])
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('uses a default name when sanitization removes the label', async () => {
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64, label: '///' })
    expect(stored.name).toBe('generated-image.png')
  })

  it('rejects conversation IDs that escape the store directory', async () => {
    await expect(saveGeneratedImage({ conversationId: '../escape', result: PNG_1X1_BASE64 })).rejects.toThrow(
      /Invalid conversation id/
    )
    await expect(saveGeneratedImage({ conversationId: 'a/b', result: PNG_1X1_BASE64 })).rejects.toThrow(
      /Invalid conversation id/
    )
  })
})

describe('materializeGeneratedImage', () => {
  const makeWorkspace = (): string => {
    const workspace = path.join(h.userData, 'workspace')
    mkdirSync(workspace, { recursive: true })
    return workspace
  }

  it('writes atomically with the actual extension and exact relative path', async () => {
    const workspace = makeWorkspace()
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })

    const materialized = await materializeGeneratedImage({
      conversationId: 'conv1',
      artifactId: stored.artifactId,
      expectedByteSize: stored.byteSize,
      cwd: workspace,
      outputPath: 'public\\images\\hero.webp',
    })

    expect(materialized).toEqual({ path: 'public/images/hero.png', existed: false })
    expect(readFileSync(path.join(workspace, materialized.path))).toEqual(Buffer.from(PNG_1X1_BASE64, 'base64'))
    expect(readdirSync(path.join(workspace, 'public/images'))).toEqual(['hero.png'])
  })

  it('overwrites regular files without temporary leftovers and reports existing destinations', async () => {
    const workspace = makeWorkspace()
    const destination = path.join(workspace, 'assets/hero.png')
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, 'old')
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })

    await expect(
      materializeGeneratedImage({
        conversationId: 'conv1',
        artifactId: stored.artifactId,
        cwd: workspace,
        outputPath: 'assets/hero.jpg',
      })
    ).resolves.toEqual({ path: 'assets/hero.png', existed: true })
    expect(readFileSync(destination)).toEqual(Buffer.from(PNG_1X1_BASE64, 'base64'))
    expect(readdirSync(path.dirname(destination))).toEqual(['hero.png'])
  })

  it('rejects traversal and absolute paths before writes', () => {
    const workspace = makeWorkspace()
    for (const outputPath of [
      '../escape.png',
      '..\\escape.png',
      '/tmp/escape.png',
      'C:\\escape.png',
      'C:escape.png',
      'assets/',
    ]) {
      expect(() => resolveGeneratedImageOutputTarget(workspace, outputPath)).toThrow(/worktree|file name/i)
    }
    expect(existsSync(path.join(h.userData, 'escape.png'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects an intermediate directory symlink outside the worktree',
    async () => {
      const workspace = makeWorkspace()
      const outside = path.join(h.userData, 'outside')
      mkdirSync(outside)
      symlinkSync(outside, path.join(workspace, 'linked-assets'))
      const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })

      await expect(
        materializeGeneratedImage({
          conversationId: 'conv1',
          artifactId: stored.artifactId,
          cwd: workspace,
          outputPath: 'linked-assets/hero.png',
        })
      ).rejects.toThrow(/outside.*worktree/i)
      expect(existsSync(path.join(outside, 'hero.png'))).toBe(false)
    }
  )

  it('preserves copied project assets after chat cleanup', async () => {
    const workspace = makeWorkspace()
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    const materialized = await materializeGeneratedImage({
      conversationId: 'conv1',
      artifactId: stored.artifactId,
      cwd: workspace,
      outputPath: 'public/hero.png',
    })

    await deleteConversationGeneratedImages('conv1')

    expect(existsSync(path.join(root(), 'conv1'))).toBe(false)
    expect(existsSync(path.join(workspace, materialized.path))).toBe(true)
  })
})

describe('readGeneratedImage', () => {
  it('returns stored artifact bytes', async () => {
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    const read = await readGeneratedImage('conv1', stored.artifactId)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.mediaType).toBe('image/png')
    expect(read.byteSize).toBe(stored.byteSize)
    expect(Buffer.from(read.bytes).toString('base64')).toBe(PNG_1X1_BASE64)
  })

  it('never exposes another conversation artifact even with the correct handle', async () => {
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    await expect(readGeneratedImage('conv2', stored.artifactId)).resolves.toEqual({ ok: false, error: 'not-found' })
  })

  it('rejects traversal handles before path construction', async () => {
    await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    for (const handle of ['../conv1/x', 'a/b', '..', '']) {
      await expect(readGeneratedImage('conv1', handle)).resolves.toEqual({ ok: false, error: 'not-found' })
    }
    await expect(readGeneratedImage('../escape', 'abc')).resolves.toEqual({ ok: false, error: 'invalid' })
  })

  it('reports externally deleted artifacts as missing', async () => {
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    rmSync(path.join(root(), 'conv1', `${stored.artifactId}.png`))
    await expect(readGeneratedImage('conv1', stored.artifactId)).resolves.toEqual({ ok: false, error: 'not-found' })
  })

  it('reports invalid when the disk file is no longer a valid image', async () => {
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    writeFileSync(path.join(root(), 'conv1', `${stored.artifactId}.png`), 'corrupted')
    await expect(readGeneratedImage('conv1', stored.artifactId)).resolves.toEqual({ ok: false, error: 'invalid' })
  })

  it('detects truncated images despite valid signatures', async () => {
    const stored = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    const file = path.join(root(), 'conv1', `${stored.artifactId}.png`)
    writeFileSync(file, Buffer.from(PNG_1X1_BASE64, 'base64').subarray(0, 8))

    await expect(readGeneratedImage('conv1', stored.artifactId, stored.byteSize)).resolves.toEqual({
      ok: false,
      error: 'invalid',
    })
  })
})

describe('cleanup', () => {
  it('removes only the requested artifacts', async () => {
    const first = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    const second = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })

    await deleteGeneratedImages('conv1', [first.artifactId])

    expect(existsSync(path.join(root(), 'conv1', `${first.artifactId}.png`))).toBe(false)
    expect(existsSync(path.join(root(), 'conv1', `${second.artifactId}.png`))).toBe(true)
  })

  it('ignores invalid and missing handles without throwing', async () => {
    await expect(deleteGeneratedImages('conv1', ['../escape', 'nope'])).resolves.toBeUndefined()
    await expect(deleteGeneratedImages('../escape', ['abc'])).resolves.toBeUndefined()
  })

  it('removes conversation directories while preserving other conversations', async () => {
    const mine = await saveGeneratedImage({ conversationId: 'conv1', result: PNG_1X1_BASE64 })
    const other = await saveGeneratedImage({ conversationId: 'conv2', result: PNG_1X1_BASE64 })

    await deleteConversationGeneratedImages('conv1')

    expect(existsSync(path.join(root(), 'conv1'))).toBe(false)
    expect(existsSync(path.join(root(), 'conv2', `${other.artifactId}.png`))).toBe(true)
    await expect(readGeneratedImage('conv1', mine.artifactId)).resolves.toEqual({ ok: false, error: 'not-found' })
  })
})
