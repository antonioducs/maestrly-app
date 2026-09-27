import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EventEmitter } from 'node:events'
import { spawn, type SpawnOptions } from 'node:child_process'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(), spawnSync: vi.fn(actual.spawnSync) }
})

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
import { setConversationScreen, type ConversationScreen } from '../../src/main/conversation-screen'

async function clientForComputer(convId = 'primary') {
  const server = new McpServer({ name: 'computer-test', version: '1' })
  registerComputerTools({ server, convId, locale: 'en', t: (() => '') as never })
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

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }

function fakeXdotool(
  onSpawn: (args: string[], child: FakeChild, options: SpawnOptions | undefined, command: string) => void
): void {
  vi.mocked(spawn).mockImplementation(((command: string, args: string[], options?: SpawnOptions) => {
    const child = new EventEmitter() as FakeChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('close', null))
      return true
    })
    onSpawn(args, child, options, command)
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

describe('computer tools on a conversation screen', () => {
  const botScreen: ConversationScreen = {
    display: ':2',
    width: 1024,
    height: 768,
    windowArea: { x: 1280, y: 0, width: 1280, height: 800 },
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('bot-a screen'),
  ])
  const spawnOptions = (index: number) => vi.mocked(spawn).mock.calls[index]?.[2] as SpawnOptions | undefined
  const spawned = () => vi.mocked(spawn).mock.calls.map((call) => [call[0], call[1]])

  afterEach(() => {
    setConversationScreen('bot-a', null)
    vi.useRealTimers()
  })

  async function clients() {
    const a = await clientForComputer('bot-a')
    const b = await clientForComputer('plain')
    return {
      a: a.client,
      b: b.client,
      close: async () => {
        await a.client.close()
        await a.server.close()
        await b.client.close()
        await b.server.close()
      },
    }
  }

  it('clicks and captures on the registered display while other conversations keep the primary screen', async () => {
    setConversationScreen('bot-a', botScreen)
    fakeXdotool((_args, child, _options, command) => {
      queueMicrotask(() => {
        if (command === 'import') child.stdout.emit('data', png)
        child.emit('close', 0)
      })
    })
    const { a, b, close } = await clients()
    try {
      const shot = await a.callTool({ name: 'computer_screenshot', arguments: {} })
      expect(shot.content).toEqual([
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: expect.stringContaining('1024 × 768') },
      ])
      expect(capture.getSources).not.toHaveBeenCalled()
      expect(spawned()).toEqual([['import', ['-display', ':2', '-window', 'root', 'png:-']]])

      vi.mocked(spawn).mockClear()
      const clicked = await a.callTool({ name: 'computer_click', arguments: { x: 1000, y: 700 } })
      expect(clicked.isError).toBeFalsy()
      expect(spawned()).toEqual([
        ['xdotool', ['mousemove', '--sync', '1000', '700']],
        ['xdotool', ['click', '1']],
      ])
      for (const index of [0, 1]) {
        expect(spawnOptions(index)?.env?.DISPLAY).toBe(':2')
        expect(spawnOptions(index)?.env?.PATH).toBe(process.env.PATH)
      }
      const outside = await a.callTool({ name: 'computer_click', arguments: { x: 1100, y: 10 } })
      expect(outside.isError).toBe(true)
      expect(JSON.stringify(outside.content)).toContain('0..1023')

      vi.mocked(spawn).mockClear()
      const plainShot = await b.callTool({ name: 'computer_screenshot', arguments: {} })
      expect(plainShot.content).toEqual([
        { type: 'image', data: Buffer.from('PNG').toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: expect.stringContaining('1280 × 800') },
      ])
      expect(capture.getSources).toHaveBeenCalledOnce()
      const plainClick = await b.callTool({ name: 'computer_click', arguments: { x: 1100, y: 10 } })
      expect(plainClick.isError).toBeFalsy()
      expect(spawned().map(([command]) => command)).toEqual(['xdotool', 'xdotool'])
      expect(spawnOptions(0)).not.toHaveProperty('env')
      expect(spawnOptions(1)).not.toHaveProperty('env')
    } finally {
      await close()
    }
  })

  it('cancels only the actions of the conversation whose screen is aborted', async () => {
    setConversationScreen('bot-a', botScreen)
    const children: Array<{ display: string | undefined; args: string[]; child: FakeChild }> = []
    let releasePlain = false
    fakeXdotool((args, child, options) => {
      const display = options?.env?.DISPLAY
      children.push({ display, args, child })
      if (display === undefined && releasePlain) queueMicrotask(() => child.emit('close', 0))
    })
    const { a, b, close } = await clients()
    try {
      const pendingA = a.callTool({ name: 'computer_click', arguments: { x: 10, y: 10 } })
      const pendingB = b.callTool({ name: 'computer_click', arguments: { x: 20, y: 20 } })
      await vi.waitFor(() => expect(children).toHaveLength(2))
      const childA = children.find((entry) => entry.display === ':2')?.child
      const childB = children.find((entry) => entry.display === undefined)?.child

      abortScreenActions('bot-a')

      const resultA = await pendingA
      expect(resultA.isError).toBe(true)
      expect(JSON.stringify(resultA.content)).toContain('interrupted:')
      expect(childA?.kill).toHaveBeenCalledWith('SIGTERM')
      expect(childB?.kill).not.toHaveBeenCalled()

      releasePlain = true
      childB?.emit('close', 0)
      const resultB = await pendingB
      expect(resultB.isError).toBeFalsy()
      expect(JSON.stringify(resultB.content)).toContain('Desktop click completed.')
      expect(children.filter((entry) => entry.display === undefined).map((entry) => entry.args[0])).toEqual([
        'mousemove',
        'click',
      ])
    } finally {
      await close()
    }
  })

  it('keeps registered screens running when an unscreened conversation aborts, and aborts all without an id', async () => {
    setConversationScreen('bot-a', botScreen)
    const children: Array<{ display: string | undefined; child: FakeChild }> = []
    fakeXdotool((_args, child, options) => {
      children.push({ display: options?.env?.DISPLAY, child })
    })
    const { a, b, close } = await clients()
    try {
      const pendingA = a.callTool({ name: 'computer_move', arguments: { x: 10, y: 10 } })
      const pendingB = b.callTool({ name: 'computer_move', arguments: { x: 20, y: 20 } })
      await vi.waitFor(() => expect(children).toHaveLength(2))
      const childA = children.find((entry) => entry.display === ':2')?.child

      abortScreenActions('plain')
      expect(JSON.stringify((await pendingB).content)).toContain('interrupted:')
      expect(childA?.kill).not.toHaveBeenCalled()

      abortScreenActions()
      expect(JSON.stringify((await pendingA).content)).toContain('interrupted:')
      expect(childA?.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      await close()
    }
  })

  it('stops a screen capture larger than 32 MiB', async () => {
    setConversationScreen('bot-a', botScreen)
    let importer: FakeChild | undefined
    fakeXdotool((_args, child) => {
      importer = child
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(32 * 1024 * 1024))
        child.stdout.emit('data', Buffer.alloc(1))
      })
    })
    const { a, close } = await clients()
    try {
      const shot = await a.callTool({ name: 'computer_screenshot', arguments: {} })
      expect(shot.isError).toBe(true)
      expect(JSON.stringify(shot.content)).toContain('32 MiB')
      expect(importer?.kill).toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('stops a screen capture after 10 seconds', async () => {
    setConversationScreen('bot-a', botScreen)
    let started: (child: FakeChild) => void = () => {}
    const importer = new Promise<FakeChild>((resolve) => {
      started = resolve
    })
    fakeXdotool((_args, child) => started(child))
    const { a, close } = await clients()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const shot = a.callTool({ name: 'computer_screenshot', arguments: {} })
      const child = await importer
      await vi.advanceTimersByTimeAsync(9_999)
      expect(child.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(child.kill).toHaveBeenCalled()
      const result = await shot
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('timed out')
    } finally {
      vi.useRealTimers()
      await close()
    }
  })

  it('offers desktop tools only when both xdotool and import run', async () => {
    for (const [importStatus, available] of [
      [1, false],
      [0, true],
    ] as const) {
      vi.resetModules()
      const childProcess = await import('node:child_process')
      vi.mocked(childProcess.spawnSync).mockImplementation(((command: string) => ({
        status: command === 'import' ? importStatus : 0,
      })) as unknown as typeof childProcess.spawnSync)
      try {
        const computer = await import('../../src/main/mcp/tools/computer')
        expect(computer.canUseComputer('linux', ':0')).toBe(available)
        expect(childProcess.spawnSync).toHaveBeenCalledWith('xdotool', ['--version'], expect.anything())
        expect(childProcess.spawnSync).toHaveBeenCalledWith('import', ['-version'], expect.anything())
      } finally {
        vi.mocked(childProcess.spawnSync).mockReset()
      }
    }
  })
})
