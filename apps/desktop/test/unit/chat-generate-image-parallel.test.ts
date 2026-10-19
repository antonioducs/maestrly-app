import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/chat/generated-images', () => ({
  resolveGeneratedImageOutputCandidates: (cwd: string, output: string) => [`${cwd}/${output}`],
  materializeGeneratedImage: vi.fn(async ({ cwd, outputPath }: { cwd: string; outputPath: string }) => ({
    path: `${cwd}/${outputPath}`,
    existed: false,
  })),
  deleteGeneratedImages: vi.fn(async () => undefined),
}))

import { generateImageTool } from '../../src/main/chat/tools/generate-image'
import { isHostToolParallelSafe } from '../../src/main/chat/tool-policy'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const image = { artifactId: 'a1', name: 'image.png', byteSize: 10 }
function ctx(generate: () => Promise<unknown>) {
  return {
    conversationId: 'c1',
    cwd: '/w',
    signal: new AbortController().signal,
    ask: vi.fn(async () => undefined),
    emitGeneratedImage: vi.fn(),
    generateImage: generate,
  } as never
}

describe('generate_image in parallel', () => {
  it('declares itself parallel-safe but not read-only', () => {
    expect(generateImageTool.metadata).toEqual({ parallelSafe: true, readOnly: false })
    expect(isHostToolParallelSafe('generate_image', generateImageTool.metadata)).toBe(true)
  })

  it('refuses a second call that writes the same outputPath while the first runs', async () => {
    const first = deferred<unknown>()
    const running = generateImageTool.execute(
      { prompt: 'a', outputPath: 'img/hero.png' },
      ctx(() => first.promise)
    )
    await expect(
      generateImageTool.execute(
        { prompt: 'b', outputPath: 'img/hero.png' },
        ctx(async () => image)
      )
    ).rejects.toThrow(/already writing img\/hero\.png/)
    await expect(
      generateImageTool.execute(
        { prompt: 'c', outputPath: 'img/other.png' },
        ctx(async () => image)
      )
    ).resolves.toMatchObject({ outputPath: '/w/img/other.png' })
    first.resolve(image)
    await running
    await expect(
      generateImageTool.execute(
        { prompt: 'd', outputPath: 'img/hero.png' },
        ctx(async () => image)
      )
    ).resolves.toMatchObject({ outputPath: '/w/img/hero.png' })
  })
})
