import { describe, it, expect, vi, afterEach } from 'vitest'
import type { WebContents } from 'electron'
import { nativeImage } from 'electron'
import * as bc from '../../src/main/browser-control'
import { MAX_EPHEMERAL_IMAGE_BYTES, decodedBase64ByteSize } from '../../src/main/chat/tool-output'

/**
 * browser_screenshot must never return decoded PNG bytes above MAX_EPHEMERAL_IMAGE_BYTES.
 * The host would silently discard an oversized image.
 * Real browser frames do not run in Node tests; the presentation subscription returns captured PNGs,
 * and a fake Electron nativeImage supplies controllable byte density.
 */
interface FakeImageSpec {
  width: number
  height: number
  /** Bytes returned by fake toPNG at the requested dimensions, simulating real PNG density. */
  pngBytesFor: (width: number, height: number) => number
}

interface FakeNativeImage {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  resize: (opts: { width: number; height: number }) => FakeNativeImage
  toPNG: () => Buffer
}

function fakeNativeImage(spec: FakeImageSpec, resizeCalls: Array<{ width: number; height: number }>): FakeNativeImage {
  return {
    isEmpty: (): boolean => false,
    getSize: (): { width: number; height: number } => ({ width: spec.width, height: spec.height }),
    resize: (opts: { width: number; height: number }): FakeNativeImage => {
      resizeCalls.push(opts)
      return fakeNativeImage({ ...spec, width: opts.width, height: opts.height }, resizeCalls)
    },
    toPNG: (): Buffer => Buffer.alloc(Math.max(0, Math.round(spec.pngBytesFor(spec.width, spec.height)))),
  }
}

function makeWebContents(captureData: string): {
  wc: WebContents
  sendCommand: ReturnType<typeof vi.fn>
  beginFrameSubscription: ReturnType<typeof vi.fn>
  endFrameSubscription: ReturnType<typeof vi.fn>
  invalidate: ReturnType<typeof vi.fn>
} {
  const sendCommand = vi.fn(async (method: string) => {
    switch (method) {
      case 'Page.addScriptToEvaluateOnNewDocument':
        return { identifier: 's1' }
      default:
        return {}
    }
  })
  const frame = {
    isEmpty: () => false,
    toPNG: () => Buffer.from(captureData, 'base64'),
  }
  const beginFrameSubscription = vi.fn(
    (_onlyDirty: boolean, callback: (image: typeof frame, rect: Record<string, number>) => void) => {
      queueMicrotask(() => callback(frame, { x: 0, y: 0, width: 800, height: 600 }))
    }
  )
  const endFrameSubscription = vi.fn()
  const invalidate = vi.fn()
  const wc = {
    debugger: { attach: vi.fn(async () => {}), on: vi.fn(), off: vi.fn(), sendCommand },
    once: vi.fn(),
    beginFrameSubscription,
    endFrameSubscription,
    invalidate,
  }
  return {
    wc: wc as unknown as WebContents,
    sendCommand,
    beginFrameSubscription,
    endFrameSubscription,
    invalidate,
  }
}

describe('browser-control screenshot model byte limit', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns a recoverable error when Chromium does not respond to capture', async () => {
    const { wc, beginFrameSubscription, endFrameSubscription } = makeWebContents('unused')
    beginFrameSubscription.mockImplementation(() => {})

    await expect(bc.screenshot(wc, { timeoutMs: 20 })).rejects.toThrow(
      'browser frame capture exceeded 20 ms without a browser response; try again.'
    )
    expect(endFrameSubscription).toHaveBeenCalledOnce()
  })

  it('immediately cancels screenshot waiting when the turn is interrupted', async () => {
    const { wc, beginFrameSubscription, endFrameSubscription } = makeWebContents('unused')
    beginFrameSubscription.mockImplementation(() => {})
    const controller = new AbortController()

    const capture = bc.screenshot(wc, { timeoutMs: 5_000, signal: controller.signal })
    controller.abort()

    await expect(capture).rejects.toThrow('browser frame capture cancelled.')
    expect(endFrameSubscription).toHaveBeenCalledOnce()
  })

  it('uses the owner-provided surface capture without a parallel subscription', async () => {
    const data = Buffer.alloc(128).toString('base64')
    vi.spyOn(nativeImage, 'createFromBuffer').mockImplementation((() =>
      fakeNativeImage({ width: 800, height: 600, pngBytesFor: () => 128 }, [])) as never)
    const { wc, beginFrameSubscription, sendCommand } = makeWebContents(data)
    const captureFrame = vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from(data, 'base64'),
    }))

    await expect(bc.screenshot(wc, { timeoutMs: 2_000, captureFrame: captureFrame as never })).resolves.toBe(data)

    expect(captureFrame).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(beginFrameSubscription).not.toHaveBeenCalled()
    expect(sendCommand).not.toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())
  })

  it('ignores late frames after the deadline and does not start an orphaned CDP capture', async () => {
    let onFrame: ((image: { isEmpty(): boolean; toPNG(): Buffer }) => void) | undefined
    const { wc, beginFrameSubscription, endFrameSubscription, sendCommand } = makeWebContents('unused')
    beginFrameSubscription.mockImplementation((_onlyDirty, callback) => {
      onFrame = callback
    })

    await expect(bc.screenshot(wc, { timeoutMs: 20 })).rejects.toThrow(/exceeded 20 ms/)
    onFrame?.({ isEmpty: () => false, toPNG: () => Buffer.from('late') })
    await Promise.resolve()

    expect(endFrameSubscription).toHaveBeenCalledOnce()
    expect(sendCommand).not.toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())
  })

  it('returns the native PNG without re-encoding when dimensions, pixels and bytes fit', async () => {
    const data = Buffer.alloc(1024, 7).toString('base64')
    const { wc, sendCommand, beginFrameSubscription, endFrameSubscription, invalidate } = makeWebContents(data)
    const resizeCalls: Array<{ width: number; height: number }> = []
    const spy = vi
      .spyOn(nativeImage, 'createFromBuffer')
      .mockImplementation((() =>
        fakeNativeImage({ width: 800, height: 600, pngBytesFor: () => 1024 }, resizeCalls)) as never)

    await expect(bc.screenshot(wc)).resolves.toBe(data)
    expect(spy).toHaveBeenCalledOnce()
    expect(resizeCalls).toHaveLength(0)
    expect(beginFrameSubscription).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledOnce()
    expect(endFrameSubscription).toHaveBeenCalledOnce()
    expect(sendCommand).not.toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())
  })

  it('preserves aspect ratio while resizing screenshots above the actual 16 MiB limit', async () => {
    const big = Buffer.alloc(MAX_EPHEMERAL_IMAGE_BYTES + 512 * 1024, 3).toString('base64')
    const resizeCalls: Array<{ width: number; height: number }> = []
    vi.spyOn(nativeImage, 'createFromBuffer').mockImplementation((() =>
      fakeNativeImage({ width: 2000, height: 1500, pngBytesFor: (w, h) => (w * h) / 32 }, resizeCalls)) as never)
    const { wc } = makeWebContents(big)

    const out = await bc.screenshot(wc)

    expect(resizeCalls).toHaveLength(1)
    const [r] = resizeCalls
    expect(r.width).toBeLessThan(2000)
    // Preserve the 2000:1500 aspect ratio.
    expect(Math.round((r.width / r.height) * 1000)).toBe(Math.round((2000 / 1500) * 1000))
    const outSize = decodedBase64ByteSize(out)
    expect(outSize).not.toBeNull()
    expect(outSize as number).toBeLessThanOrEqual(MAX_EPHEMERAL_IMAGE_BYTES)
  })

  it('retries at a smaller scale when re-encoding still exceeds the limit', async () => {
    const capture = Buffer.alloc(10_000, 1).toString('base64')
    const resizeCalls: Array<{ width: number; height: number }> = []
    // Twice the modeled PNG density makes the first attempt exceed the limit.
    vi.spyOn(nativeImage, 'createFromBuffer').mockImplementation((() =>
      fakeNativeImage({ width: 2000, height: 1500, pngBytesFor: (w, h) => (w * h) / 16 }, resizeCalls)) as never)
    const { wc } = makeWebContents(capture)

    const out = await bc.screenshot(wc, { maxBytes: 1000 })

    expect(resizeCalls.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < resizeCalls.length; i++) {
      expect(resizeCalls[i].width).toBeLessThan(resizeCalls[i - 1].width)
    }
    const outSize = decodedBase64ByteSize(out)
    expect(outSize).not.toBeNull()
    expect(outSize as number).toBeLessThanOrEqual(1000)
  })

  it('enforces the 2560-pixel dimension limit on ultrawide viewports', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 5).toString('base64')
    const resizeCalls: Array<{ width: number; height: number }> = []
    vi.spyOn(nativeImage, 'createFromBuffer').mockImplementation((() =>
      fakeNativeImage({ width: 6000, height: 1200, pngBytesFor: (w, h) => (w * h) / 64 }, resizeCalls)) as never)
    const { wc } = makeWebContents(big)

    const out = await bc.screenshot(wc)

    expect(resizeCalls).toHaveLength(1)
    expect(resizeCalls[0].width).toBe(2560)
    // Preserve the 6000:1200 aspect ratio, resulting in height 512.
    expect(resizeCalls[0].height).toBe(512)
    expect(decodedBase64ByteSize(out) as number).toBeLessThanOrEqual(MAX_EPHEMERAL_IMAGE_BYTES)
  })

  it('resizes highly compressible ultrawide PNGs even below the byte limit', async () => {
    const compressible = Buffer.alloc(4096, 0).toString('base64')
    const resizeCalls: Array<{ width: number; height: number }> = []
    vi.spyOn(nativeImage, 'createFromBuffer').mockImplementation((() =>
      fakeNativeImage({ width: 10_000, height: 500, pngBytesFor: () => 4096 }, resizeCalls)) as never)
    const { wc, sendCommand } = makeWebContents(compressible)

    const out = await bc.screenshot(wc)

    expect(resizeCalls).toEqual([expect.objectContaining({ width: 2560, height: 128 })])
    expect(sendCommand).not.toHaveBeenCalledWith('Page.getLayoutMetrics')
    expect(decodedBase64ByteSize(out)).toBeLessThanOrEqual(MAX_EPHEMERAL_IMAGE_BYTES)
  })

  it('respects the pixel limit even when both dimensions are below 2560', async () => {
    const compressible = Buffer.alloc(4096, 0).toString('base64')
    const resizeCalls: Array<{ width: number; height: number }> = []
    vi.spyOn(nativeImage, 'createFromBuffer').mockImplementation((() =>
      fakeNativeImage({ width: 2500, height: 2000, pngBytesFor: () => 4096 }, resizeCalls)) as never)
    const { wc } = makeWebContents(compressible)

    await bc.screenshot(wc)

    expect(resizeCalls).toHaveLength(1)
    expect(resizeCalls[0].width * resizeCalls[0].height).toBeLessThanOrEqual(bc.SCREENSHOT_MAX_PIXELS)
  })

  it('throws instead of returning an oversized image when decoding fails', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 9).toString('base64')
    vi.spyOn(nativeImage, 'createFromBuffer').mockImplementation((() => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    })) as never)
    const { wc } = makeWebContents(big)

    await expect(bc.screenshot(wc)).rejects.toThrow(/screenshot/i)
  })
})
