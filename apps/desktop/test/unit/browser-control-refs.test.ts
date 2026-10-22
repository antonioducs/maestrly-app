import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { clickRef, dragRef, evaluate, snapshot } from '../../src/main/browser-control'

vi.mock('../../src/main/performance/metrics', () => ({
  incrementPerformanceCounter: vi.fn(),
}))

interface Evaluation {
  expression: string
  contextId?: number
}

/**
 * A page whose debugger answers the commands of a snapshot and of actions on its refs. `isolated` decides whether the
 * page can have the tools' isolated world; `resolve` answers the lookup of a ref there.
 */
class FakePage extends EventEmitter {
  readonly evaluations: Evaluation[] = []
  readonly clicks: Array<{ x: number; y: number }> = []
  readonly worlds: number[] = []
  isolated = true
  failNextWith: string | null = null
  resolve: () => unknown = () => ({ state: 'ok', x: 300, y: 400 })
  private nextWorld = 10
  readonly debugger = Object.assign(new EventEmitter(), {
    attach: vi.fn(),
    sendCommand: vi.fn(async (method: string, params: Record<string, any> = {}) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'prompt' }
      if (method === 'Page.getFrameTree') return this.isolated ? { frameTree: { frame: { id: 'main' } } } : {}
      if (method === 'Page.createIsolatedWorld') {
        if (!this.isolated) throw new Error('not supported')
        const id = this.nextWorld++
        this.worlds.push(id)
        return { executionContextId: id }
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed') this.clicks.push({ x: params.x, y: params.y })
        return {}
      }
      if (method !== 'Runtime.evaluate') return {}
      this.evaluations.push({ expression: params.expression, contextId: params.contextId })
      if (this.failNextWith && params.contextId !== undefined) {
        const message = this.failNextWith
        this.failNextWith = null
        throw new Error(message)
      }
      if (params.expression === 'location.href') return { result: { value: 'https://page.test/' } }
      if (params.expression.includes('querySelectorAll')) {
        return {
          result: {
            value: {
              viewport: { width: 800, height: 600 },
              scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
              elements: [
                { ref: 0, tag: 'button', type: '', name: 'first', x: 10, y: 20 },
                { ref: 1, tag: 'a', type: '', name: 'second', x: 30, y: 40 },
              ],
            },
          },
        }
      }
      if (params.expression.includes('__maestrlyRefs')) return { result: { value: this.resolve() } }
      return { result: { type: 'number', value: 2 } }
    }),
  })
  getURL = () => 'https://page.test/'
  isDestroyed = () => false
  isCrashed = () => false
  canGoBack = () => false
  canGoForward = () => false
  goBack = vi.fn()
  goForward = vi.fn()
  reload = vi.fn()
  loadURL = vi.fn(async () => {})
  forcefullyCrashRenderer = vi.fn()

  navigateMainFrame(): void {
    this.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://next.test/' } })
  }
}

const snapshotEvaluation = (page: FakePage) => page.evaluations.find((e) => e.expression.includes('querySelectorAll'))!

describe('browser refs in the tools’ isolated world', () => {
  it('snapshots in the isolated world, keeps the elements there and acts where they are now', async () => {
    const page = new FakePage()
    const snap = await snapshot(page as never)
    expect(snap.elements.map((element) => element.name)).toEqual(['first', 'second'])
    const taken = snapshotEvaluation(page)
    expect(taken.contextId).toBe(10)
    expect(taken.expression).toContain('globalThis.__maestrlyRefs={token:')
    // Shadow roots and same-origin frames are read too.
    expect(taken.expression).toContain('el.shadowRoot')
    expect(taken.expression).toContain('contentDocument')

    await clickRef(page as never, 1)
    const lookup = page.evaluations.at(-1)!
    expect(lookup.contextId).toBe(10)
    expect(lookup.expression).toContain('kept.refs[1]')
    expect(lookup.expression).toContain('scrollIntoView')
    // The element's position now, not the snapshot's.
    expect(page.clicks).toEqual([{ x: 300, y: 400 }])
  })

  it('refuses a ref whose element left the page, or that is from before a navigation', async () => {
    const page = new FakePage()
    await snapshot(page as never)
    page.resolve = () => ({ state: 'detached' })
    await expect(clickRef(page as never, 0)).rejects.toThrow(
      'ref 0 is no longer on the page; call browser_snapshot again'
    )
    page.resolve = () => ({ state: 'hidden' })
    await expect(clickRef(page as never, 0)).rejects.toThrow('is no longer visible')

    page.navigateMainFrame()
    page.resolve = () => ({ state: 'stale' })
    await expect(clickRef(page as never, 0)).rejects.toThrow('is from before the page changed')
    // The navigation replaced the world: the lookup ran in a new one.
    expect(page.worlds).toEqual([10, 11])
    expect(page.evaluations.at(-1)!.contextId).toBe(11)
    await expect(clickRef(page as never, 7)).rejects.toThrow('invalid ref 7; call browser_snapshot first')
    expect(page.clicks).toEqual([])
  })

  it('creates the world again once when the page replaced it', async () => {
    const page = new FakePage()
    await snapshot(page as never)
    page.failNextWith = 'Cannot find context with specified id'
    await clickRef(page as never, 0)
    expect(page.worlds).toEqual([10, 11])
    expect(page.clicks).toEqual([{ x: 300, y: 400 }])
  })

  it('reads a page without an isolated world from its own world, keeping nothing there', async () => {
    const page = new FakePage()
    page.isolated = false
    await snapshot(page as never)
    const taken = snapshotEvaluation(page)
    expect(taken.contextId).toBeUndefined()
    expect(taken.expression).not.toContain('__maestrlyRefs')
    await clickRef(page as never, 1)
    expect(page.clicks).toEqual([{ x: 30, y: 40 }])
  })

  it('drags between refs where they are, without scrolling either away', async () => {
    const page = new FakePage()
    await snapshot(page as never)
    await dragRef(page as never, 0, 1)
    const lookups = page.evaluations.filter((e) => e.expression.includes('kept.refs['))
    expect(lookups).toHaveLength(2)
    expect(lookups.every((e) => e.expression.includes('if(!p.inView&&false)'))).toBe(true)
  })

  it('evaluates scripts as a user action, as the DevTools console does', async () => {
    const page = new FakePage()
    await evaluate(page as never, '1+1')
    const call = page.debugger.sendCommand.mock.calls.find(
      ([method, params]) => method === 'Runtime.evaluate' && params?.expression === '1+1'
    )
    expect(call?.[1]).toMatchObject({ userGesture: true, replMode: true })
  })
})
