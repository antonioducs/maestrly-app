import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ decoderVisibleDuringImport: null as boolean | null, imports: 0 }))

vi.mock('@novnc/novnc', () => {
  // Runs while the module "evaluates": noVNC probes WebCodecs at this point.
  seen.imports += 1
  seen.decoderVisibleDuringImport = 'VideoDecoder' in globalThis
  return { default: class FakeRfb {} }
})

class FakeVideoDecoder {}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'VideoDecoder')
})

describe('noVNC loader', () => {
  it('hides the WebCodecs decoder while noVNC evaluates and restores it afterwards', async () => {
    Object.defineProperty(globalThis, 'VideoDecoder', {
      value: FakeVideoDecoder,
      configurable: true,
      writable: true,
    })
    const { loadNoVnc } = await import('../../src/renderer/lib/fleet/load-novnc')
    const first = loadNoVnc()
    const second = loadNoVnc()
    expect(second).toBe(first)
    const module = await first
    expect(typeof module.default).toBe('function')
    expect(seen.decoderVisibleDuringImport).toBe(false)
    expect(seen.imports).toBe(1)
    expect((globalThis as { VideoDecoder?: unknown }).VideoDecoder).toBe(FakeVideoDecoder)
  })

  it('never imports noVNC statically, so app startup never runs its hardware decoder probe', () => {
    const read = (name: string) =>
      readFileSync(fileURLToPath(new URL(`../../src/renderer/components/fleet/${name}.tsx`, import.meta.url)), 'utf8')
    // Bot and environment screens stream through the shared screen hook, which loads the viewer on demand.
    const frame = read('ScreenFrame')
    expect(frame).toMatch(/import type RFB from '@novnc\/novnc'/)
    expect(frame).toContain('loadNoVnc()')
    for (const name of ['ScreenFrame', 'BotScreen', 'EnvironmentScreen'])
      expect(read(name), name).not.toMatch(/^import (?!type )[^\n]*from '@novnc\/novnc'/m)
    expect(read('BotScreen')).toContain('useFleetScreen(')
    expect(read('EnvironmentScreen')).toContain('useFleetScreen(')
  })
})
