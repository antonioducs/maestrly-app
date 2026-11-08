import { beforeEach, expect, it, vi } from 'vitest'
import {
  type AssistantBrowserWindow,
  AssistantWindow,
  type AssistantWindowDeps,
  assistantBounds,
} from '../../src/main/assistant/assistant-window'
import { parseAssistantSettings } from '../../src/shared/assistant'

type Rect = { x: number; y: number; width: number; height: number }

class FakeWindow {
  visible = false
  focused = false
  destroyed = false
  bounds: Rect
  listeners = new Map<string, ((event?: { preventDefault(): void }) => void)[]>()
  sent: [string, unknown][] = []
  workspaces: unknown[] = []
  webContents = {
    isDestroyed: () => this.destroyed,
    send: (channel: string, payload: unknown) => this.sent.push([channel, payload]),
  }
  constructor(readonly options: Record<string, unknown>) {
    this.bounds = {
      x: options.x as number,
      y: options.y as number,
      width: options.width as number,
      height: options.height as number,
    }
  }
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  isFocused = () => this.focused
  show = () => {
    this.visible = true
  }
  hide = () => {
    this.visible = false
    this.focused = false
  }
  focus = () => {
    this.focused = true
  }
  destroy = () => {
    this.destroyed = true
  }
  getBounds = () => this.bounds
  setBounds = (bounds: Rect) => {
    this.bounds = bounds
  }
  setVisibleOnAllWorkspaces = (...args: unknown[]) => {
    this.workspaces.push(args)
  }
  on = (event: string, listener: (event?: { preventDefault(): void }) => void) => {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: string, arg?: { preventDefault(): void }) {
    for (const listener of this.listeners.get(event) ?? []) listener(arg)
  }
}

const h = vi.hoisted(() => ({ windows: [] as unknown[] }))

let settings = parseAssistantSettings({})
let area: Rect = { x: 0, y: 0, width: 1440, height: 900 }
let saved: Rect | null = null
let registered: [unknown, unknown][] = []
let conversation = 'assistant-1'

function deps(overrides: Partial<AssistantWindowDeps> = {}): AssistantWindowDeps {
  return {
    create: (options) => {
      const win = new FakeWindow(options as Record<string, unknown>)
      h.windows.push(win)
      return win as unknown as AssistantBrowserWindow
    },
    load: async () => {},
    settings: () => settings,
    conversationId: async () => conversation,
    registerTarget: (wc, metadata) => registered.push([wc, metadata]),
    cursorWorkArea: () => area,
    savedBounds: () => saved,
    saveBounds: (bounds) => {
      saved = bounds
    },
    platform: 'darwin',
    preload: '/preload.js',
    ...overrides,
  }
}

const last = () => h.windows[h.windows.length - 1] as FakeWindow

beforeEach(() => {
  h.windows = []
  settings = parseAssistantSettings({})
  area = { x: 0, y: 0, width: 1440, height: 900 }
  saved = null
  registered = []
  conversation = 'assistant-1'
})

it('creates one window and toggles it', async () => {
  const assistant = new AssistantWindow(deps())
  await assistant.toggle()
  expect(h.windows).toHaveLength(1)
  expect(assistant.isVisible()).toBe(true)
  await assistant.toggle()
  expect(assistant.isVisible()).toBe(false)
  await assistant.toggle()
  expect(h.windows).toHaveLength(1)
  expect(assistant.isVisible()).toBe(true)
})

it('brings a window left behind others to the front instead of hiding it', async () => {
  const assistant = new AssistantWindow(deps())
  await assistant.show()
  last().focused = false
  await assistant.toggle()
  expect(assistant.isVisible()).toBe(true)
  expect(last().focused).toBe(true)
})

it('opens frameless, floating and off the taskbar, on the display under the cursor', async () => {
  area = { x: 1440, y: 0, width: 1920, height: 1080 }
  const assistant = new AssistantWindow(deps())
  await assistant.show()
  const win = last()
  expect(win.options).toMatchObject({ frame: false, alwaysOnTop: true, skipTaskbar: true, show: false })
  expect(win.options.webPreferences).toMatchObject({ preload: '/preload.js', contextIsolation: true })
  expect(win.bounds).toEqual({ x: 1440 + 720, y: 220, width: 480, height: 640 })
  expect(win.workspaces).toEqual([[true, { visibleOnFullScreen: true }]])
})

it('reuses saved bounds only while they fit the display', () => {
  const display = { x: 0, y: 0, width: 1440, height: 900 }
  expect(assistantBounds(display, { x: 10, y: 10, width: 500, height: 600 })).toEqual({
    x: 10,
    y: 10,
    width: 500,
    height: 600,
  })
  expect(assistantBounds(display, { x: 2000, y: 10, width: 500, height: 600 })).toEqual({
    x: 480,
    y: 130,
    width: 480,
    height: 640,
  })
})

it('registers the window for the assistant conversation and again after a new session', async () => {
  const assistant = new AssistantWindow(deps())
  await assistant.show()
  expect(registered).toEqual([[last().webContents, { global: true, convId: 'assistant-1', panel: 'assistant' }]])
  conversation = 'assistant-2'
  await assistant.retarget()
  expect(registered[1]).toEqual([last().webContents, { global: true, convId: 'assistant-2', panel: 'assistant' }])
  expect(assistant.conversationId()).toBe('assistant-2')
})

it('tells the renderer whether the shortcut should start listening', async () => {
  const assistant = new AssistantWindow(deps())
  await assistant.show({ listen: true })
  expect(last().sent).toContainEqual(['assistant:shown', { listen: true }])
})

it('taps the voice instead of hiding while it listens or reads', async () => {
  const assistant = new AssistantWindow(deps())
  await assistant.show()
  for (const reason of ['listening', 'speaking']) {
    assistant.setHold(reason, true)
    last().sent = []
    await assistant.toggle({ listen: false })
    expect(assistant.isVisible(), reason).toBe(true)
    expect(last().sent, reason).toEqual([['assistant:shown', { listen: true }]])
    assistant.setHold(reason, false)
  }
  await assistant.toggle()
  expect(assistant.isVisible()).toBe(false)
})

it('hides on blur unless a question or a recording holds it, or the setting is off', async () => {
  const assistant = new AssistantWindow(deps())
  await assistant.show()
  assistant.setHold('question', true)
  last().emit('blur')
  expect(assistant.isVisible()).toBe(true)
  assistant.setHold('question', false)
  last().emit('blur')
  expect(assistant.isVisible()).toBe(false)
  settings = parseAssistantSettings({ hideOnBlur: false })
  await assistant.show()
  last().emit('blur')
  expect(assistant.isVisible()).toBe(true)
})

it('hides instead of closing, and closes for real on dispose', async () => {
  const assistant = new AssistantWindow(deps())
  await assistant.show()
  const prevent = vi.fn()
  last().emit('close', { preventDefault: prevent })
  expect(prevent).toHaveBeenCalled()
  expect(assistant.isVisible()).toBe(false)
  assistant.dispose()
  expect(last().destroyed).toBe(true)
  expect(saved).toEqual(last().bounds)
  await assistant.show()
  expect(h.windows).toHaveLength(1)
})
