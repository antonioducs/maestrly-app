import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FleetScreenChannel, type ScreenApi } from '../../src/renderer/lib/fleet/screen-channel'

type State = Parameters<Parameters<ScreenApi['onFleetScreenState']>[0]>[0]
type Data = Parameters<Parameters<ScreenApi['onFleetScreenData']>[0]>[0]
function fakeApi() {
  let state: (value: State) => void = () => {}
  let data: (value: Data) => void = () => {}
  const api = {
    fleetScreenOpen: vi.fn(async () => ({ channelId: 'ch1' })),
    fleetScreenSend: vi.fn(async (_channelId: string, _bytes: ArrayBuffer) => {}),
    fleetScreenClose: vi.fn(async (_channelId: string) => {}),
    onFleetScreenState: vi.fn((callback: typeof state) => {
      state = callback
      return vi.fn()
    }),
    onFleetScreenData: vi.fn((callback: typeof data) => {
      data = callback
      return vi.fn()
    }),
  } satisfies ScreenApi
  return { api, emitState: (value: State) => state(value), emitData: (value: Data) => data(value) }
}
beforeEach(() => {
  vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  vi.stubGlobal(
    'CloseEvent',
    class {
      code: number
      reason: string
      constructor(_type: string, options: { code: number; reason: string }) {
        this.code = options.code
        this.reason = options.reason
      }
    }
  )
})
describe('fleet raw screen channel', () => {
  it('buffers events that arrive before opening resolves and exposes an already-open channel', async () => {
    const fake = fakeApi()
    fake.api.fleetScreenOpen.mockImplementationOnce(async () => {
      fake.emitState({ channelId: 'ch1', state: 'open' })
      fake.emitData({ channelId: 'ch1', data: new Uint8Array([1, 2]).buffer })
      return { channelId: 'ch1' }
    })
    const channel = await FleetScreenChannel.open(fake.api, 'bot', 'view')
    expect(channel.readyState).toBe(1)
    const received: number[] = []
    channel.onmessage = (event) => received.push(...new Uint8Array(event.data))
    expect(received).toEqual([1, 2])
  })
  it('supports a later open, binary slices, receive, and close codes', async () => {
    const fake = fakeApi()
    const channel = await FleetScreenChannel.open(fake.api, 'bot', 'control')
    const opened = vi.fn()
    const closed = vi.fn()
    const received = vi.fn()
    channel.onopen = opened
    channel.onclose = closed
    channel.onmessage = received
    expect(channel.readyState).toBe(0)
    fake.emitState({ channelId: 'ch1', state: 'open' })
    expect(opened).toHaveBeenCalledOnce()
    channel.send(new Uint8Array([8, 9, 10]).subarray(1))
    expect(new Uint8Array(fake.api.fleetScreenSend.mock.calls[0][1])).toEqual(new Uint8Array([9, 10]))
    fake.emitData({ channelId: 'other', data: new ArrayBuffer(1) })
    fake.emitData({ channelId: 'ch1', data: new Uint8Array([3]).buffer })
    expect(new Uint8Array(received.mock.calls[0][0].data)).toEqual(new Uint8Array([3]))
    fake.emitState({ channelId: 'ch1', state: 'closed', code: 4002, reason: 'offline' })
    expect(channel.readyState).toBe(3)
    expect(closed.mock.calls[0][0].code).toBe(4002)
  })
  it('closes through preload and handles an error', async () => {
    const fake = fakeApi()
    const channel = await FleetScreenChannel.open(fake.api, 'bot', 'view')
    const failed = vi.fn()
    channel.onerror = failed
    fake.emitState({ channelId: 'ch1', state: 'error' })
    expect(failed).toHaveBeenCalledOnce()
    channel.close()
    expect(channel.readyState).toBe(2)
    expect(fake.api.fleetScreenClose).toHaveBeenCalledWith('ch1')
  })
})
