import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

const capture = vi.hoisted(() => ({
  getSources: vi.fn(async () => [
    { display_id: '1', thumbnail: { isEmpty: () => false, toPNG: () => Buffer.from('PNG') } },
  ]),
  getPrimaryDisplay: vi.fn(() => ({ id: 1, size: { width: 1280, height: 800 } })),
}))
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  desktopCapturer: { getSources: capture.getSources },
  screen: { getPrimaryDisplay: capture.getPrimaryDisplay },
}))

import {
  abortScreenActions,
  canUseComputer,
  computerArguments,
  registerComputerTools,
} from '../../src/main/mcp/tools/computer'
import { APP_TOOL_POLICY } from '../../src/main/chat/tool-policy'
import { toolsFromClient } from '../../src/main/chat/mcp'
import { InstanceHoldManager, registerInstanceHoldGate } from '../../src/main/fleet/instance/gate'

async function clientForComputer() {
  const server = new McpServer({ name: 'computer-test', version: '1' })
  registerComputerTools({ server, convId: 'primary', locale: 'en', t: (() => '') as never })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'computer-client', version: '1' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

function fakeXdotool(onSpawn: (args: string[], child: EventEmitter) => void): void {
  vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }
    child.stderr = new EventEmitter()
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('close', null))
      return true
    })
    onSpawn(args, child)
    return child
  }) as unknown as typeof spawn)
}

describe('computer actions', () => {
  const size = { width: 1280, height: 800 }
  it('builds exact xdotool argument arrays without a shell', () => {
    expect(computerArguments('move', { x: 0, y: 799 }, size)).toEqual([['mousemove', '--sync', '0', '799']])
    expect(computerArguments('click', { x: 10, y: 20 }, size)).toEqual([
      ['mousemove', '--sync', '10', '20'],
      ['click', '1'],
    ])
    expect(computerArguments('click', { x: 10, y: 20, button: 'right', double: true }, size)).toEqual([
      ['mousemove', '--sync', '10', '20'],
      ['click', '--repeat', '2', '3'],
    ])
    expect(computerArguments('drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }, size)).toEqual([
      ['mousemove', '--sync', '1', '2'],
      ['mousedown', '1'],
      ['mousemove', '--sync', '3', '4'],
      ['mouseup', '1'],
    ])
    for (const [direction, button] of [
      ['up', '4'],
      ['down', '5'],
      ['left', '6'],
      ['right', '7'],
    ]) {
      expect(computerArguments('scroll', { x: 3, y: 4, direction, amount: 2 }, size)).toEqual([
        ['mousemove', '--sync', '3', '4'],
        ['click', '--repeat', '2', button],
      ])
    }
    expect(computerArguments('type', { text: 'hi; `x`' }, size)).toEqual([['type', '--delay', '12', '--', 'hi; `x`']])
    const chunks = computerArguments('type', { text: 'x'.repeat(401) }, size)
    expect(chunks.map((chunk) => chunk[4].length)).toEqual([200, 200, 1])
    expect(computerArguments('key', { keys: 'ctrl+s Return' }, size)).toEqual([
      ['key', '--clearmodifiers', '--', 'ctrl+s', 'Return'],
    ])
  })

  it('rejects out-of-bounds, noninteger, invalid key and oversized inputs', () => {
    for (const input of [
      { x: -1, y: 0 },
      { x: 1280, y: 0 },
      { x: 0, y: 800 },
      { x: 1.5, y: 0 },
    ])
      expect(() => computerArguments('move', input, size)).toThrow('Coordinates')
    expect(() => computerArguments('drag', { fromX: 0, fromY: 0, toX: 1280, toY: 0 }, size)).toThrow()
    expect(() => computerArguments('scroll', { x: 0, y: 0, direction: 'up', amount: 21 }, size)).toThrow()
    expect(() => computerArguments('type', { text: 'x'.repeat(4001) }, size)).toThrow()
    for (const keys of ['', 'ctrl;rm', 'x'.repeat(65), '  '])
      expect(() => computerArguments('key', { keys }, size)).toThrow()
    expect(canUseComputer('darwin', ':1')).toBe(false)
    expect(canUseComputer('linux', undefined)).toBe(false)
  })

  it('returns a PNG image and screen pixel guidance', async () => {
    const { client, server } = await clientForComputer()
    try {
      const result = await client.callTool({ name: 'computer_screenshot', arguments: {} })
      expect(result.content).toEqual([
        { type: 'image', data: Buffer.from('PNG').toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: expect.stringContaining('1280 × 800') },
      ])
      expect(capture.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: size })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('refuses the real screenshot tool while the primary conversation is held', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const { client, server } = await clientForComputer()
    const manager = new InstanceHoldManager()
    const unregister = registerInstanceHoldGate(manager, 'primary')
    try {
      const tools = await toolsFromClient(
        client,
        (name) => name,
        () => '',
        async () => {},
        undefined,
        undefined,
        undefined,
        {},
        'primary'
      )
      const screenshot = tools.computer_screenshot as unknown as {
        execute(input: unknown, options: { toolCallId: string }): Promise<unknown>
      }
      await manager.hold('takeover', false, async () => {})
      await expect(screenshot.execute({}, { toolCallId: 'shot' })).rejects.toThrow('taken over')
      expect(capture.getSources).not.toHaveBeenCalled()
    } finally {
      unregister()
      await client.close()
      await server.close()
      vi.unstubAllEnvs()
    }
  })

  it('classifies desktop tools like browser capture and interaction tools', () => {
    expect(APP_TOOL_POLICY.computer_screenshot).toEqual(APP_TOOL_POLICY.browser_screenshot)
    expect(APP_TOOL_POLICY.computer_click).toEqual(APP_TOOL_POLICY.browser_click)
    expect(APP_TOOL_POLICY.computer_move).toEqual(APP_TOOL_POLICY.browser_mouse_move)
    expect(APP_TOOL_POLICY.computer_drag).toEqual(APP_TOOL_POLICY.browser_drag)
    expect(APP_TOOL_POLICY.computer_scroll).toEqual(APP_TOOL_POLICY.browser_scroll)
    expect(APP_TOOL_POLICY.computer_type).toEqual(APP_TOOL_POLICY.browser_type)
    expect(APP_TOOL_POLICY.computer_key).toEqual(APP_TOOL_POLICY.browser_press_key)
  })

  it('aborts an in-flight screen action before granting a hold', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    fakeXdotool(() => {})
    const { client, server } = await clientForComputer()
    const manager = new InstanceHoldManager()
    const unregister = registerInstanceHoldGate(manager, 'primary')
    try {
      const tools = await toolsFromClient(
        client,
        (name) => name,
        () => '',
        async () => {},
        undefined,
        undefined,
        undefined,
        {},
        'primary'
      )
      const move = tools.computer_move as unknown as {
        execute(input: unknown, options: { toolCallId: string }): Promise<unknown>
      }
      const pending = move.execute({ x: 10, y: 20 }, { toolCallId: 'move' })
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      const hold = manager.hold('takeover', true, async () => {})
      expect(manager.state.state).toBe('holding')
      await expect(pending).resolves.toMatchObject({ isError: true, text: expect.stringContaining('interrupted:') })
      expect(await hold).toMatchObject({ state: 'held', interruptedTurn: true })
    } finally {
      unregister()
      await client.close()
      await server.close()
    }
  })

  it('stops typing between chunks and releases a drag after interruption', async () => {
    fakeXdotool((args, child) => {
      if (args[0] === 'type') {
        abortScreenActions()
        queueMicrotask(() => child.emit('close', 0))
      } else if (args[0] === 'mousemove' && args[2] === '3') {
        abortScreenActions()
        queueMicrotask(() => child.emit('close', null))
      } else queueMicrotask(() => child.emit('close', 0))
    })
    const { client, server } = await clientForComputer()
    try {
      const typed = await client.callTool({ name: 'computer_type', arguments: { text: 'x'.repeat(401) } })
      expect(typed.isError).toBe(true)
      expect(JSON.stringify(typed.content)).toContain('interrupted:')
      expect(vi.mocked(spawn).mock.calls.filter((call) => call[1]?.[0] === 'type')).toHaveLength(1)
      vi.mocked(spawn).mockClear()
      const dragged = await client.callTool({
        name: 'computer_drag',
        arguments: { fromX: 1, fromY: 2, toX: 3, toY: 4 },
      })
      expect(dragged.isError).toBe(true)
      expect(JSON.stringify(dragged.content)).toContain('interrupted:')
      expect(vi.mocked(spawn).mock.calls.map((call) => call[1]?.[0])).toEqual([
        'mousemove',
        'mousedown',
        'mousemove',
        'mouseup',
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })
})
