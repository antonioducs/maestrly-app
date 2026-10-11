import { describe, expect, it } from 'vitest'
import {
  type HoldState,
  PresentationGate,
  presentationForTool,
  presentsOnCompletion,
} from '../../src/main/fleet/instance/desktop/presentation'

const NO_HOLD: HoldState = { state: 'none', reason: null }
const TAKEOVER_HELD: HoldState = { state: 'held', reason: 'takeover' }
const TAKEOVER_HOLDING: HoldState = { state: 'holding', reason: 'takeover' }
const PAUSED_HELD: HoldState = { state: 'held', reason: 'paused' }
const PAUSED_HOLDING: HoldState = { state: 'holding', reason: 'paused' }

const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_click',
  'browser_double_click',
  'browser_right_click',
  'browser_type',
  'browser_press_key',
  'browser_drag',
  'browser_scroll',
  'browser_mouse_move',
  'browser_new_tab',
  'browser_switch_tab',
]

const BROWSER_READS = [
  'browser_snapshot',
  'browser_screenshot',
  'browser_read_text',
  'browser_console_logs',
  'browser_network_logs',
  'browser_evaluate',
  'browser_wait_for',
  'browser_tabs',
  'browser_clear_logs',
  'browser_set_dialog_behavior',
]

describe('presentationForTool', () => {
  it('brings the browser forward for navigation and input tools, with or without the MCP prefix', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(presentationForTool(tool, {}), tool).toEqual({ app: 'browser' })
      expect(presentationForTool(`mcp__maestrly__${tool}`, {}), tool).toEqual({ app: 'browser' })
    }
  })

  it('accepts any MCP server name in the prefix', () => {
    expect(presentationForTool('mcp__other-server__browser_click', { ref: 3 })).toEqual({ app: 'browser' })
    expect(presentationForTool('mcp__my_server__browser_navigate', { url: 'https://example.com' })).toEqual({
      app: 'browser',
    })
  })

  it('does not bring the window forward for reads', () => {
    for (const tool of BROWSER_READS) {
      expect(presentationForTool(tool, {}), tool).toBeNull()
      expect(presentationForTool(`mcp__maestrly__${tool}`, {}), tool).toBeNull()
    }
  })

  it('brings the addressed terminal forward for terminal_send and terminal_run', () => {
    expect(presentationForTool('terminal_send', { id: 'term-1', text: 'ls\n' })).toEqual({
      app: 'terminal',
      terminalId: 'term-1',
    })
    expect(presentationForTool('mcp__maestrly__terminal_run', { id: 'abc', command: 'ls' })).toEqual({
      app: 'terminal',
      terminalId: 'abc',
    })
  })

  it('falls back to no specific terminal when the id is missing or not a string', () => {
    expect(presentationForTool('terminal_send', {})).toEqual({ app: 'terminal', terminalId: null })
    expect(presentationForTool('terminal_run', { id: 7 })).toEqual({ app: 'terminal', terminalId: null })
    expect(presentationForTool('terminal_run', { id: '' })).toEqual({ app: 'terminal', terminalId: null })
    expect(presentationForTool('terminal_run', { id: null })).toEqual({ app: 'terminal', terminalId: null })
  })

  it('maps terminal_create to the terminal app without an id', () => {
    expect(presentationForTool('terminal_create', { cwd: '/tmp' })).toEqual({ app: 'terminal', terminalId: null })
    expect(presentationForTool('mcp__maestrly__terminal_create', {})).toEqual({ app: 'terminal', terminalId: null })
  })

  it('ignores terminal tools that do not act on the desktop', () => {
    for (const tool of ['terminal_read', 'terminal_list', 'terminal_snapshot', 'terminal_close', 'terminal_signal']) {
      expect(presentationForTool(tool, { id: 'term-1' }), tool).toBeNull()
    }
  })

  it('ignores unrelated tools and names that only look like tools', () => {
    expect(presentationForTool('Read', { path: 'a.txt' })).toBeNull()
    expect(presentationForTool('mcp__maestrly__notes_quick_append', { text: 'x' })).toBeNull()
    expect(presentationForTool('', {})).toBeNull()
    expect(presentationForTool('mcp__maestrly__', {})).toBeNull()
    expect(presentationForTool('mcp__browser_click', {})).toBeNull()
    expect(presentationForTool('xbrowser_click', {})).toBeNull()
    expect(presentationForTool('browser_click_all', {})).toBeNull()
  })

  it('handles malformed input', () => {
    for (const input of [null, undefined, 42, 'text', true, [], [1, 2]]) {
      expect(presentationForTool('terminal_send', input)).toEqual({ app: 'terminal', terminalId: null })
      expect(presentationForTool('browser_click', input)).toEqual({ app: 'browser' })
      expect(presentationForTool('browser_snapshot', input)).toBeNull()
    }
  })
})

describe('presentsOnCompletion', () => {
  it('flags only tools whose window appears after they finish', () => {
    expect(presentsOnCompletion('terminal_create')).toBe(true)
    expect(presentsOnCompletion('mcp__maestrly__terminal_create')).toBe(true)
    expect(presentsOnCompletion('terminal_send')).toBe(false)
    expect(presentsOnCompletion('terminal_run')).toBe(false)
    expect(presentsOnCompletion('browser_new_tab')).toBe(false)
    expect(presentsOnCompletion('mcp__maestrly__browser_click')).toBe(false)
    expect(presentsOnCompletion('')).toBe(false)
  })
})

describe('PresentationGate', () => {
  const browser = { app: 'browser' } as const
  const terminal = { app: 'terminal', terminalId: 'term-1' } as const

  function gateWithClock(intervalMs?: number) {
    const clock = { now: 1_000 }
    const gate = new PresentationGate({ now: () => clock.now, ...(intervalMs === undefined ? {} : { intervalMs }) })
    return { clock, gate }
  }

  it('allows the first request', () => {
    const { gate } = gateWithClock()
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
  })

  it('allows at most one request per 250 ms for an app', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
    clock.now += 100
    expect(gate.allow(browser, NO_HOLD)).toBe(false)
    clock.now += 149
    expect(gate.allow(browser, NO_HOLD)).toBe(false)
    clock.now += 1
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
    clock.now += 249
    expect(gate.allow(browser, NO_HOLD)).toBe(false)
  })

  it('measures the interval from the last allowed request, not from rejected ones', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
    for (let i = 0; i < 3; i++) {
      clock.now += 100
      expect(gate.allow(browser, NO_HOLD)).toBe(i === 2)
    }
  })

  it('tracks the browser and the terminal independently', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
    expect(gate.allow(terminal, NO_HOLD)).toBe(true)
    clock.now += 10
    expect(gate.allow(browser, NO_HOLD)).toBe(false)
    expect(gate.allow(terminal, NO_HOLD)).toBe(false)
  })

  it('counts every terminal id as the same terminal app', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow({ app: 'terminal', terminalId: 'a' }, NO_HOLD)).toBe(true)
    clock.now += 10
    expect(gate.allow({ app: 'terminal', terminalId: 'b' }, NO_HOLD)).toBe(false)
    expect(gate.allow({ app: 'terminal', terminalId: null }, NO_HOLD)).toBe(false)
    clock.now += 240
    expect(gate.allow({ app: 'terminal', terminalId: 'b' }, NO_HOLD)).toBe(true)
  })

  it('honours a custom interval', () => {
    const { clock, gate } = gateWithClock(1_000)
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
    clock.now += 999
    expect(gate.allow(browser, NO_HOLD)).toBe(false)
    clock.now += 1
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
  })

  it('never presents while a takeover hold is active', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow(browser, TAKEOVER_HELD)).toBe(false)
    expect(gate.allow(browser, TAKEOVER_HOLDING)).toBe(false)
    expect(gate.allow(terminal, TAKEOVER_HELD)).toBe(false)
    clock.now += 10_000
    expect(gate.allow(browser, TAKEOVER_HELD)).toBe(false)
    expect(gate.allow(browser, TAKEOVER_HELD, { force: true })).toBe(false)
  })

  it('does not consume the interval while suppressed by a takeover', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow(browser, TAKEOVER_HELD)).toBe(false)
    clock.now += 1
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
  })

  it('presents again once the takeover ends', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow(browser, TAKEOVER_HELD)).toBe(false)
    clock.now += 500
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
  })

  it('does not treat a paused hold as a takeover', () => {
    const { gate } = gateWithClock()
    expect(gate.allow(browser, PAUSED_HELD)).toBe(true)
    expect(gate.allow(terminal, PAUSED_HOLDING)).toBe(true)
  })

  it('lets a forced request bypass the interval and restarts it', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
    clock.now += 10
    expect(gate.allow(browser, NO_HOLD)).toBe(false)
    expect(gate.allow(browser, NO_HOLD, { force: true })).toBe(true)
    clock.now += 100
    expect(gate.allow(browser, NO_HOLD)).toBe(false)
    clock.now += 150
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
  })

  it('recovers when the clock moves backwards', () => {
    const { clock, gate } = gateWithClock()
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
    clock.now -= 5_000
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
  })

  it('uses the real clock by default', () => {
    const gate = new PresentationGate()
    expect(gate.allow(browser, NO_HOLD)).toBe(true)
    expect(gate.allow(browser, NO_HOLD)).toBe(false)
    expect(gate.allow(terminal, NO_HOLD)).toBe(true)
  })
})
