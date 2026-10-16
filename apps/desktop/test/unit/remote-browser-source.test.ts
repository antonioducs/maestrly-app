import { describe, expect, it } from 'vitest'
import { nextSource, type SourceState } from '../../src/renderer/lib/remote-browser-source'

const start = (transport: 'video' | 'jpeg'): SourceState =>
  nextSource({ transport: 'jpeg', pictures: 0 }, { type: 'started', transport }).state

describe('the remote Browser tab picture source', () => {
  it('stays on frames when the host sends frames', () => {
    const state = start('jpeg')
    expect(nextSource(state, { type: 'video-error' })).toEqual({ state, fallBack: false })
    expect(nextSource(state, { type: 'video-closed', code: 1006 })).toEqual({ state, fallBack: false })
  })

  it('falls back to frames when the video breaks, before or after its first picture', () => {
    expect(nextSource(start('video'), { type: 'video-error' })).toEqual({
      state: { transport: 'jpeg', pictures: 0 },
      fallBack: true,
    })
    let state = start('video')
    state = nextSource(state, { type: 'picture' }).state
    state = nextSource(state, { type: 'picture' }).state
    expect(state).toEqual({ transport: 'video', pictures: 2 })
    expect(nextSource(state, { type: 'video-closed', code: 1006 })).toEqual({
      state: { transport: 'jpeg', pictures: 2 },
      fallBack: true,
    })
    expect(nextSource(state, { type: 'video-closed', code: 4002 }).fallBack).toBe(true)
    expect(nextSource(state, { type: 'video-closed', code: null }).fallBack).toBe(true)
  })

  it('keeps the video when its stream ends as meant to', () => {
    const state = start('video')
    for (const code of [1000, 4001])
      expect(nextSource(state, { type: 'video-closed', code })).toEqual({ state, fallBack: false })
  })
})
