import type { IpcMainEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerSoundIpc } from '../../src/main/sound/ipc'
import type { SoundService } from '../../src/main/sound/service'
import { createTestRegistrar } from './ipc-registrar-test-utils'

const sender = (id: string) => ({ id }) as unknown as WebContents
const event = (wc: WebContents) => ({ sender: wc }) as IpcMainEvent

describe('registerSoundIpc', () => {
  it('registers readiness and ACK as sensitive mon channels', () => {
    const { reg, mons, ons } = createTestRegistrar()
    registerSoundIpc(reg, {
      service: { setRendererReady: vi.fn(), acknowledge: vi.fn() } as unknown as SoundService,
      getTarget: () => null,
    })
    expect([...mons.keys()]).toEqual(['sound:renderer-ready', 'sound:ack'])
    expect(ons.size).toBe(0)
  })

  it('accepts only the main sender and valid ACKs, blocking panels', () => {
    const { reg, mons } = createTestRegistrar()
    const main = sender('main')
    const panel = sender('panel')
    const service = { setRendererReady: vi.fn(), acknowledge: vi.fn() }
    registerSoundIpc(reg, { service: service as unknown as SoundService, getTarget: () => main })

    mons.get('sound:renderer-ready')!(event(panel))
    mons.get('sound:renderer-ready')!(event(main))
    expect(service.setRendererReady).toHaveBeenCalledTimes(1)
    expect(service.setRendererReady).toHaveBeenCalledWith(main)

    mons.get('sound:ack')!(event(panel), { requestId: 'r1', status: 'started' })
    mons.get('sound:ack')!(event(main), { requestId: '', status: 'started' })
    mons.get('sound:ack')!(event(main), { requestId: 'r1', status: 'failed', reason: 'not-allowed' })
    expect(service.acknowledge).not.toHaveBeenCalled()

    const ack = { requestId: 'r1', status: 'failed' as const, reason: 'decode-failed' as const }
    mons.get('sound:ack')!(event(main), ack)
    expect(service.acknowledge).toHaveBeenCalledWith(main, ack)
  })
})
