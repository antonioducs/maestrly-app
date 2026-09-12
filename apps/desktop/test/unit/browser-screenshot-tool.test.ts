import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('../../src/main/drawer-manager', () => ({
  acquireBrowserForControl: vi.fn(),
  touchActiveBrowserActivity: vi.fn(),
  getBrowserState: vi.fn(() => ({ tabs: [], activeId: null })),
  createBrowserTab: vi.fn(),
  closeBrowserTab: vi.fn(),
  switchBrowserTab: vi.fn(),
}))
vi.mock('../../src/main/browser-control', () => ({
  navigate: vi.fn(),
  navHistory: vi.fn(),
  waitFor: vi.fn(),
  snapshot: vi.fn(),
  clickRef: vi.fn(),
  doubleClickRef: vi.fn(),
  rightClickRef: vi.fn(),
  dragRef: vi.fn(),
  typeRef: vi.fn(),
  pressKey: vi.fn(),
  readText: vi.fn(),
  screenshot: vi.fn(),
  evaluate: vi.fn(),
  moveMouse: vi.fn(),
  scroll: vi.fn(),
  getConsoleLogs: vi.fn(),
  getNetworkLogs: vi.fn(),
  clearLogs: vi.fn(),
  setDialogBehavior: vi.fn(),
  mousePosition: vi.fn(),
  scrollPosition: vi.fn(),
}))

import { registerBrowserTools } from '../../src/main/mcp/tools/browser'
import * as drawerManager from '../../src/main/drawer-manager'
import * as bc from '../../src/main/browser-control'
import { tFor } from '../../src/shared/i18n'

/**
 * browser_screenshot tool contract (rl_afb0b8cc55d4): return the bounded image with mouse/scroll metadata.
 * Adaptive resizing happens in browser-control and must preserve the text annotation accompanying
 * the image.
 */
describe('browser_screenshot (MCP tool) — image and mouse/scroll metadata', () => {
  let server: McpServer
  let client: Client

  beforeEach(async () => {
    server = new McpServer({ name: 'app-tools', version: '1.0.0' })
    registerBrowserTools({ server, convId: 'c1', locale: 'en', t: tFor('en', 'mcp') })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'screenshot-test-client', version: '1.0.0' })
    await server.connect(serverT)
    await client.connect(clientT)
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  })

  it('returns the bounded image with mouse/scroll metadata even after resizing', async () => {
    const fakeWc = { fake: true }
    const captureFrame = vi.fn()
    vi.mocked(drawerManager.acquireBrowserForControl).mockReturnValue({
      webContents: fakeWc,
      captureFrame,
      release: vi.fn(),
    } as never)
    vi.mocked(bc.screenshot).mockResolvedValue('b3Zlci1idWRnZXQ=')
    vi.mocked(bc.mousePosition).mockReturnValue({ x: 42, y: 7 })
    vi.mocked(bc.scrollPosition).mockResolvedValue({ x: 0, y: 120, maxX: 0, maxY: 1000 })

    const result = (await client.callTool({ name: 'browser_screenshot', arguments: {} })) as {
      content: Array<Record<string, unknown>>
    }

    const image = result.content.find((c) => c.type === 'image') as { data?: string; mimeType?: string }
    const text = result.content.find((c) => c.type === 'text') as { text?: string }
    expect(image?.data).toBe('b3Zlci1idWRnZXQ=')
    expect(image?.mimeType).toBe('image/png')
    expect(text?.text).toContain('42')
    expect(text?.text).toContain('7')
    expect(text?.text).toContain('120')
    expect(text?.text).toContain('1000')
    expect(text?.text).toContain('12%') // Scroll progress is 120 out of 1000.
    // Use the host default limit and propagate cancellation to capture and bounded metadata.
    expect(bc.screenshot).toHaveBeenCalledWith(fakeWc, {
      signal: expect.any(AbortSignal),
      captureFrame,
    })
    expect(bc.scrollPosition).toHaveBeenCalledWith(fakeWc, {
      signal: expect.any(AbortSignal),
      timeoutMs: 1_000,
    })
    expect(vi.mocked(bc.screenshot).mock.calls[0][1]?.signal).toBe(
      vi.mocked(bc.scrollPosition).mock.calls[0][1]?.signal
    )
  })

  it('preserves PNG when only scroll metadata fails', async () => {
    const fakeWc = { fake: true }
    vi.mocked(drawerManager.acquireBrowserForControl).mockReturnValue({
      webContents: fakeWc,
      captureFrame: vi.fn(),
      release: vi.fn(),
    } as never)
    vi.mocked(bc.screenshot).mockResolvedValue('cG5n')
    vi.mocked(bc.mousePosition).mockReturnValue({ x: 3, y: 4 })
    vi.mocked(bc.scrollPosition).mockRejectedValue(new Error('Runtime.evaluate timed out'))

    const result = (await client.callTool({ name: 'browser_screenshot', arguments: {} })) as {
      content: Array<Record<string, unknown>>
      isError?: boolean
    }

    expect(result.isError).not.toBe(true)
    expect(result.content).toContainEqual({ type: 'image', data: 'cG5n', mimeType: 'image/png' })
    expect(result.content.find((entry) => entry.type === 'text')).toMatchObject({
      text: expect.stringContaining('metadata unavailable'),
    })
  })
})
