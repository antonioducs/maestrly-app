import { describe, it, expect, vi, beforeEach } from 'vitest'

/** powerSaveBlocker is best effort: Linux logind/DBus may throw or fail silently. Start each case with fresh module state and local Electron/store mocks so failure never crashes the power manager. */

const h = vi.hoisted(() => ({
  start: vi.fn(() => 1),
  isStarted: vi.fn((_id: number) => true),
  stop: vi.fn(),
  getAppFlag: vi.fn((_k: string, def: boolean) => def),
  setAppFlag: vi.fn(),
}))

vi.mock('electron', () => ({
  powerSaveBlocker: { start: h.start, isStarted: h.isStarted, stop: h.stop },
}))
vi.mock('../../src/main/store', () => ({ getAppFlag: h.getAppFlag, setAppFlag: h.setAppFlag }))

async function freshPM() {
  vi.resetModules()
  return import('../../src/main/power-manager')
}

beforeEach(() => {
  vi.clearAllMocks()
  h.start.mockImplementation(() => 1)
  h.isStarted.mockImplementation((_id: number) => true)
  h.getAppFlag.mockImplementation((_k: string, def: boolean) => def)
})

describe('power-manager — best-effort powerSaveBlocker fallback', () => {
  it('(a) start succeeds and isStarted=true: blocks suspension while working', async () => {
    const pm = await freshPM()
    pm.initPowerManager()
    pm.onAgentStatus('a', 'working')
    expect(h.start).toHaveBeenCalledWith('prevent-app-suspension')
  })

  it('(b) start throws: onAgentStatus does not propagate the error', async () => {
    h.start.mockImplementation(() => {
      throw new Error('no dbus')
    })
    const pm = await freshPM()
    pm.initPowerManager()
    expect(() => pm.onAgentStatus('a', 'working')).not.toThrow()
  })

  it('(c) start succeeds but isStarted=false: no crash or stop call for an invalid ID', async () => {
    h.isStarted.mockImplementation((_id: number) => false)
    const pm = await freshPM()
    pm.initPowerManager()
    pm.onAgentStatus('a', 'working') // blockerId remains null.
    h.stop.mockClear()
    pm.onAgentStatus('a', 'ready') // Working reaches zero; null blockerId prevents a stop call.
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('(d) working reaches zero with an active blocker: calls stop', async () => {
    const pm = await freshPM()
    pm.initPowerManager()
    pm.onAgentStatus('a', 'working') // start → id 1, isStarted true
    pm.onAgentStatus('a', 'ready') // working→0 → stop(1)
    expect(h.stop).toHaveBeenCalledWith(1)
  })
})
