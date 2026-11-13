import { describe, expect, it, vi } from 'vitest'
import { registerAssistantIpc } from '../../src/main/assistant/assistant-ipc'

describe('assistant wake IPC', () => {
  function setup() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const reg = Object.fromEntries(
      ['handle', 'mhandle', 'on', 'mon'].map((name) => [
        name,
        (channel: string, fn: never) => handlers.set(channel, fn),
      ])
    )
    const assistant = { id: 7 }
    const wake = {
      burst: vi.fn(async () => undefined),
      micFailed: vi.fn(),
      state: vi.fn(() => ({ listening: true })),
      status: vi.fn(() => ({ listening: true, error: 'mic' as const })),
    }
    registerAssistantIpc(reg as never, {
      window: () => ({ webContents: () => assistant }) as never,
      locale: () => 'en',
      openConversationInApp: vi.fn(),
      openSettingsInApp: vi.fn(),
      applySettings: () => null,
      shortcutError: () => null,
      wayland: false,
      wake,
    })
    return { handlers, assistant, wake }
  }

  it('accepts bursts and mic failures only from the assistant window', () => {
    const { handlers, assistant, wake } = setup()
    const pcm = new Float32Array(4000)

    handlers.get('assistant:wake-burst')?.({ sender: { id: 1 } }, pcm)
    handlers.get('assistant:wake-mic-failed')?.({ sender: { id: 1 } })
    expect(wake.burst).not.toHaveBeenCalled()
    expect(wake.micFailed).not.toHaveBeenCalled()

    handlers.get('assistant:wake-burst')?.({ sender: assistant }, pcm)
    handlers.get('assistant:wake-mic-failed')?.({ sender: assistant })
    expect(wake.burst).toHaveBeenCalledWith(pcm)
    expect(wake.micFailed).toHaveBeenCalledTimes(1)
  })

  it('returns wake state only to the assistant window and wake status to any sender', async () => {
    const { handlers, assistant, wake } = setup()

    expect(await handlers.get('assistant:wake-state')?.({ sender: { id: 1 } })).toEqual({ listening: false })
    expect(await handlers.get('assistant:wake-state')?.({ sender: assistant })).toEqual({ listening: true })
    expect(await handlers.get('assistant:wake-status')?.({ sender: { id: 1 } })).toEqual({
      listening: true,
      error: 'mic',
    })
    expect(wake.status).toHaveBeenCalledTimes(1)
  })
})
