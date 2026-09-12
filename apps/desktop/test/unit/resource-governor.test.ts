import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LEASE_GRACE_MS,
  acquireAgentActivity,
  disposeResourceGovernor,
  getResourceGovernorDiagnostics,
  registerThrottleTarget,
  resourceHasVisibleSurface,
  setResourcePlacementActive,
  setResourceVisible,
  touchAgentActivity,
  unregisterThrottleTarget,
} from '../../src/main/performance/resource-governor'

type TestTarget = {
  throttled: boolean[]
  destroyed: boolean
  setBackgroundThrottling: (throttled: boolean) => void
  isDestroyed: () => boolean
  once: (event: 'destroyed', listener: () => void) => void
}

function target(): TestTarget {
  return {
    throttled: [] as boolean[],
    destroyed: false,
    setBackgroundThrottling(throttled: boolean) {
      this.throttled.push(throttled)
    },
    isDestroyed() {
      return this.destroyed
    },
    once() {
      // individual tests replace this with a listener registry when they need to simulate a race
    },
  }
}

describe('resource governor', () => {
  afterEach(() => {
    disposeResourceGovernor()
    vi.useRealTimers()
  })

  it('throttles materialized resources until they become visible', () => {
    const page = target()
    registerThrottleTarget('browser', 'conv-1', 'tab-1', page)

    expect(page.throttled.at(-1)).toBe(true)
    setResourceVisible('browser', 'conv-1', 'tab-1', true)
    expect(page.throttled.at(-1)).toBe(false)
    setResourceVisible('browser', 'conv-1', 'tab-1', false)
    expect(page.throttled.at(-1)).toBe(true)
  })

  it('keeps a popup/floating renderer awake independently of slot visibility', () => {
    const panel = target()
    registerThrottleTarget('panel', 'conv-2', 'notes', panel)
    setResourcePlacementActive('panel', 'conv-2', 'notes', 'popup', true)
    setResourceVisible('panel', 'conv-2', 'notes', false)

    expect(panel.throttled.at(-1)).toBe(false)
    setResourcePlacementActive('panel', 'conv-2', 'notes', 'popup', false)
    expect(panel.throttled.at(-1)).toBe(true)
  })

  it('distinguishes an actually visible surface from an agent-only lease', () => {
    registerThrottleTarget('chatgpt', 'conv-surface', undefined, target())
    const release = acquireAgentActivity('chatgpt', 'conv-surface')

    expect(resourceHasVisibleSurface('chatgpt', 'conv-surface')).toBe(false)
    setResourcePlacementActive('chatgpt', 'conv-surface', undefined, 'popup', true)
    expect(resourceHasVisibleSurface('chatgpt', 'conv-surface')).toBe(true)
    setResourcePlacementActive('chatgpt', 'conv-surface', undefined, 'popup', false)
    expect(resourceHasVisibleSurface('chatgpt', 'conv-surface')).toBe(false)

    release()
  })

  it('notifies visual subscribers with the exact full-speed decision', () => {
    const activity: boolean[] = []
    const panel = {
      ...target(),
      onFullSpeedChange: (fullSpeed: boolean) => {
        activity.push(fullSpeed)
      },
    }
    registerThrottleTarget('panel', 'conv-activity', 'terminal', panel)

    expect(activity).toEqual([false])
    setResourceVisible('panel', 'conv-activity', 'terminal', true)
    expect(activity).toEqual([false, true])
    setResourceVisible('panel', 'conv-activity', 'terminal', true)
    expect(activity).toEqual([false, true])
    setResourceVisible('panel', 'conv-activity', 'terminal', false)
    expect(activity).toEqual([false, true, false])
  })

  it('expires an agent lease after the grace period without disabling other reasons', () => {
    vi.useFakeTimers()
    const page = target()
    registerThrottleTarget('browser', 'conv-3', 'tab-1', page)
    touchAgentActivity('browser', 'conv-3', 'tab-1')

    expect(page.throttled.at(-1)).toBe(false)
    vi.advanceTimersByTime(AGENT_LEASE_GRACE_MS)
    expect(page.throttled.at(-1)).toBe(true)

    setResourceVisible('browser', 'conv-3', 'tab-1', true)
    touchAgentActivity('browser', 'conv-3', 'tab-1')
    vi.advanceTimersByTime(AGENT_LEASE_GRACE_MS)
    expect(page.throttled.at(-1)).toBe(false)
  })

  it('keeps an in-flight agent operation awake beyond the grace period and starts grace on release', () => {
    vi.useFakeTimers()
    const page = target()
    registerThrottleTarget('browser', 'conv-in-flight', 'tab-1', page)
    const release = acquireAgentActivity('browser', 'conv-in-flight', 'tab-1')

    vi.advanceTimersByTime(AGENT_LEASE_GRACE_MS + 1)
    expect(page.throttled.at(-1)).toBe(false)

    release()
    expect(page.throttled.at(-1)).toBe(false)
    vi.advanceTimersByTime(AGENT_LEASE_GRACE_MS)
    expect(page.throttled.at(-1)).toBe(true)
  })

  it('keeps a replacement resource independent from a stale release', () => {
    vi.useFakeTimers()
    const first = target()
    registerThrottleTarget('browser', 'conv-replaced', 'tab-1', first)
    const staleRelease = acquireAgentActivity('browser', 'conv-replaced', 'tab-1')
    unregisterThrottleTarget('browser', 'conv-replaced', 'tab-1')

    const replacement = target()
    registerThrottleTarget('browser', 'conv-replaced', 'tab-1', replacement)
    const currentRelease = acquireAgentActivity('browser', 'conv-replaced', 'tab-1')

    staleRelease()
    vi.advanceTimersByTime(AGENT_LEASE_GRACE_MS + 1)
    expect(replacement.throttled.at(-1)).toBe(false)

    currentRelease()
    vi.advanceTimersByTime(AGENT_LEASE_GRACE_MS)
    expect(replacement.throttled.at(-1)).toBe(true)
  })

  it('reports and clears resources per conversation', () => {
    registerThrottleTarget('vscode', 'conv-a', undefined, target())
    registerThrottleTarget('chatgpt', 'conv-b', undefined, target())
    setResourceVisible('chatgpt', 'conv-b', undefined, true)

    expect(getResourceGovernorDiagnostics()).toMatchObject({
      total: 2,
      fullSpeed: 1,
      throttled: 1,
      byKind: {
        vscode: { total: 1, throttled: 1 },
        chatgpt: { total: 1, fullSpeed: 1 },
      },
    })
    // disposal is idempotent and must not leave the expiry timer alive
    disposeResourceGovernor()
    expect(getResourceGovernorDiagnostics().total).toBe(0)
  })

  it('reapplies state to a recreated target without a stale destroy event deleting it', () => {
    const first = target()
    const second = target()
    const destroyListeners: Array<() => void> = []
    first.once = (_event, listener) => void destroyListeners.push(listener)
    second.once = (_event, listener) => void destroyListeners.push(listener)

    setResourceVisible('browser', 'conv-recreate', 'tab', true)
    registerThrottleTarget('browser', 'conv-recreate', 'tab', first)
    expect(first.throttled.at(-1)).toBe(false)
    registerThrottleTarget('browser', 'conv-recreate', 'tab', second)
    expect(second.throttled.at(-1)).toBe(false)

    destroyListeners[0]?.()
    expect(getResourceGovernorDiagnostics().total).toBe(1)
    setResourceVisible('browser', 'conv-recreate', 'tab', false)
    expect(second.throttled.at(-1)).toBe(true)
  })
})
