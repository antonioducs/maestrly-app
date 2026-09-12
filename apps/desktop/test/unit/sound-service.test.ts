import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoundAssetReadResult } from '../../src/main/sound/assets'
import { SoundService, type SoundServiceDeps } from '../../src/main/sound/service'

function target(): WebContents & { send: ReturnType<typeof vi.fn>; destroyed: boolean } {
  const value = {
    send: vi.fn(),
    destroyed: false,
    isDestroyed: vi.fn(() => value.destroyed),
  }
  return value as unknown as WebContents & { send: ReturnType<typeof vi.fn>; destroyed: boolean }
}

function setup(readResult: SoundAssetReadResult = { ok: true, data: Buffer.from('wav') }) {
  let now = 10_000
  const deps: SoundServiceDeps = {
    readAsset: vi.fn(() => readResult),
    playFallback: vi.fn(),
    makeRequestId: vi.fn(() => 'request-1'),
    now: vi.fn(() => now),
    warn: vi.fn(),
    timeoutMs: 100,
    warnRateLimitMs: 1000,
  }
  const service = new SoundService(deps)
  return { service, deps, advanceNow: (ms: number) => (now += ms) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SoundService', () => {
  it('falls back immediately without a ready renderer and limits warnings by cause', () => {
    const { service, deps, advanceNow } = setup()
    service.play('glass', 0.5)
    service.play('glass', 0.5)
    expect(deps.playFallback).toHaveBeenCalledTimes(2)
    expect(deps.warn).toHaveBeenCalledTimes(1)
    advanceNow(1000)
    service.play('glass', 0.5)
    expect(deps.warn).toHaveBeenCalledTimes(2)
  })

  it('sends bytes only to the ready target at the clamped volume', () => {
    const { service, deps } = setup()
    const main = target()
    service.setTarget(main)
    service.setRendererReady(main)
    service.play('glass', 2)
    expect(main.send).toHaveBeenCalledTimes(1)
    expect(main.send).toHaveBeenCalledWith(
      'sound:play',
      expect.objectContaining({ requestId: 'request-1', voice: 'glass', volume: 1, data: expect.any(ArrayBuffer) }),
    )
    expect(deps.playFallback).not.toHaveBeenCalled()
  })

  it('ACK started settles the request and prevents late fallback', () => {
    const { service, deps } = setup()
    const main = target()
    service.setTarget(main)
    service.setRendererReady(main)
    service.play('glass', 1)
    service.acknowledge(main, { requestId: 'request-1', status: 'started' })
    vi.advanceTimersByTime(100)
    expect(deps.playFallback).not.toHaveBeenCalled()
  })

  it('ACK failed and timeout trigger exactly one fallback; late ACKs are ignored', () => {
    const { service, deps } = setup()
    const main = target()
    service.setTarget(main)
    service.setRendererReady(main)
    service.play('glass', 1)
    service.acknowledge(main, { requestId: 'request-1', status: 'failed', reason: 'decode-failed' })
    service.acknowledge(main, { requestId: 'request-1', status: 'failed', reason: 'decode-failed' })
    vi.advanceTimersByTime(100)
    expect(deps.playFallback).toHaveBeenCalledTimes(1)

    vi.mocked(deps.makeRequestId).mockReturnValue('request-2')
    service.play('ping', 0.8)
    vi.advanceTimersByTime(350)
    service.acknowledge(main, { requestId: 'request-2', status: 'started' })
    expect(deps.playFallback).toHaveBeenCalledTimes(2)
    expect(deps.playFallback).toHaveBeenLastCalledWith('ping', 0.8)
  })

  it('missing assets, broken sends, and destroyed renderers fall back exactly once', () => {
    const missing = setup({ ok: false, reason: 'asset-missing' })
    const main = target()
    missing.service.setTarget(main)
    missing.service.setRendererReady(main)
    missing.service.play('glass', 1)
    expect(missing.deps.playFallback).toHaveBeenCalledTimes(1)

    const broken = setup()
    const brokenMain = target()
    brokenMain.send.mockImplementation(() => {
      throw new Error('destroyed')
    })
    broken.service.setTarget(brokenMain)
    broken.service.setRendererReady(brokenMain)
    broken.service.play('glass', 1)
    expect(broken.deps.playFallback).toHaveBeenCalledTimes(1)

    const destroyed = setup()
    const dead = target()
    destroyed.service.setTarget(dead)
    destroyed.service.setRendererReady(dead)
    dead.destroyed = true
    destroyed.service.play('glass', 1)
    expect(destroyed.deps.playFallback).toHaveBeenCalledTimes(1)
  })

  it('target replacement/invalidation falls back pending requests and rejects panel ACKs', () => {
    const { service, deps } = setup()
    const main = target()
    const panel = target()
    service.setTarget(main)
    service.setRendererReady(main)
    service.play('glass', 1)
    service.acknowledge(panel, { requestId: 'request-1', status: 'started' })
    service.invalidateRenderer(main)
    expect(deps.playFallback).toHaveBeenCalledTimes(1)
    service.setTarget(panel)
    expect(service.getTarget()).toBe(panel)
  })

  it('ignores invalid voice, volume, and fallback values without throwing', () => {
    const { service, deps } = setup()
    // @ts-expect-error defensive payload
    service.play('nope', 1)
    service.play('glass', Number.NaN)
    service.play('glass', 0)
    expect(deps.readAsset).not.toHaveBeenCalled()
    expect(deps.playFallback).not.toHaveBeenCalled()
  })
})
