import { createContext, runInContext } from 'node:vm'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { scroll, setDialogBehavior } from '../../src/main/browser-control'

vi.mock('../../src/main/performance/metrics', () => ({ incrementPerformanceCounter: vi.fn() }))

const hostileText = [
  '</script><script>globalThis.injected=true</script>',
  '";globalThis.injected=true;//',
  '${globalThis.injected=true}',
  '\\"\n\r\u2028\u2029',
]

function browser() {
  const element = {
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 400,
    scrollHeight: 600,
    clientWidth: 100,
    clientHeight: 100,
  }
  const querySelector = vi.fn(() => element)
  const context = createContext({ window: {}, document: { querySelector }, injected: false })
  const scripts: string[] = []
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      scripts.push(String(params?.source))
      return { identifier: 'script' }
    }
    if (method === 'Runtime.evaluate') return { result: { value: runInContext(String(params?.expression), context) } }
    return {}
  })
  const wc = { debugger: { attach: vi.fn(), on: vi.fn(), sendCommand }, once: vi.fn() } as unknown as WebContents
  return { wc, context, scripts, querySelector, element }
}

describe('browser CDP strings stay data in JavaScript execution contexts', () => {
  it.each(hostileText)('preserves hostile prompt text without executing it: %s', async (text) => {
    const b = browser()
    await setDialogBehavior(b.wc, true, text)
    expect(runInContext('window.prompt("question", "default")', b.context)).toBe(text)
    expect(b.context.injected).toBe(false)
    // The future-document script uses the same JavaScript-only context, never an HTML script tag.
    runInContext(b.scripts.at(-1)!, b.context)
    expect(runInContext('window.prompt()', b.context)).toBe(text)
    expect(b.context.injected).toBe(false)
  })

  it.each(hostileText)('passes selectors literally to querySelector: %s', async (text) => {
    const b = browser()
    await expect(scroll(b.wc, { container: text, y: 80 })).resolves.toMatchObject({ y: 80 })
    expect(b.querySelector).toHaveBeenCalledWith(text)
    expect(b.context.injected).toBe(false)
  })
})
