import { describe, expect, it, vi } from 'vitest'
import { THUMBNAIL_RETRY_MS, ThumbnailQueue } from '../../src/main/artifacts/thumbnail-queue'

const image = new Uint8Array([0xff, 0xd8, 0xff])

function setup(overrides: { capture?: (url: string) => Promise<Uint8Array> } = {}) {
  let now = 1_000
  const order: string[] = []
  const deps = {
    sourceUrl: vi.fn(async (id: string, version: number) => `owner:${id}:${version}`),
    capture: vi.fn(
      overrides.capture ??
        (async (url: string) => {
          order.push(url)
          return image
        })
    ),
    save: vi.fn(async (_id: string, _version: number, _image: Uint8Array) => {}),
    onError: vi.fn((_error: unknown) => {}),
    now: () => now,
  }
  const queue = new ThumbnailQueue(deps)
  return { queue, deps, order, advance: (ms: number) => (now += ms) }
}

describe('ThumbnailQueue', () => {
  it('captures one version at a time and saves each image', async () => {
    const { queue, deps, order } = setup()
    queue.request('a', 1)
    queue.request('b', 3)
    await queue.idle()
    expect(order).toEqual(['owner:a:1', 'owner:b:3'])
    expect(deps.save).toHaveBeenCalledWith('a', 1, image)
    expect(deps.save).toHaveBeenCalledWith('b', 3, image)
  })

  it('never captures the same version twice and keeps only the newest waiting version', async () => {
    const { queue, deps, order } = setup()
    queue.request('busy', 1)
    queue.request('a', 1)
    queue.request('a', 3)
    queue.request('a', 2)
    await queue.idle()
    expect(order).toEqual(['owner:busy:1', 'owner:a:3'])
    queue.request('a', 3)
    await queue.idle()
    expect(deps.capture).toHaveBeenCalledTimes(2)
  })

  it('retries a failed version only after a while, and reports failures', async () => {
    let fail = true
    const { queue, deps, advance } = setup({
      capture: async () => {
        if (fail) throw Object.assign(new Error('boom'), { code: 'load_timeout' })
        return image
      },
    })
    queue.request('a', 1)
    await queue.idle()
    expect(deps.onError).toHaveBeenCalledTimes(1)
    expect(deps.save).not.toHaveBeenCalled()
    queue.request('a', 1)
    await queue.idle()
    expect(deps.capture).toHaveBeenCalledTimes(1)
    fail = false
    advance(THUMBNAIL_RETRY_MS)
    queue.request('a', 1)
    await queue.idle()
    expect(deps.save).toHaveBeenCalledWith('a', 1, image)
  })

  it('treats a failed save like a failed capture', async () => {
    const { queue, deps } = setup()
    deps.save.mockRejectedValueOnce(new Error('not_found'))
    queue.request('gone', 1)
    await queue.idle()
    expect(deps.onError).toHaveBeenCalledTimes(1)
  })

  it('stops capturing once disposed', async () => {
    const { queue, deps } = setup()
    queue.request('a', 1)
    queue.request('b', 1)
    queue.dispose()
    await queue.idle()
    queue.request('c', 1)
    await queue.idle()
    expect(deps.save).not.toHaveBeenCalled()
  })
})
