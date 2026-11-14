import { describe, expect, it } from 'vitest'
import { createBurstGate } from '../../src/renderer/components/assistant/voice/wake-gate'
import { shouldListen } from '../../src/renderer/components/assistant/voice/wake-listener'

const FRAME = 320 // 20 ms at 16 kHz
const quiet = () => new Float32Array(FRAME).fill(0.001)
const loud = () => Float32Array.from({ length: FRAME }, (_, i) => Math.sin(i / 3) * 0.2)
function feed(gate: ReturnType<typeof createBurstGate>, frames: Float32Array[]) {
  const out: Float32Array[] = []
  for (const f of frames) {
    const burst = gate.push(f)
    if (burst) out.push(burst)
  }
  return out
}
const times = (n: number, make: () => Float32Array) => Array.from({ length: n }, make)

describe('the wake burst gate', () => {
  it('sends nothing for silence', () => {
    expect(feed(createBurstGate(), times(500, quiet))).toEqual([])
  })

  it('cuts one burst with its pre-roll after 600 ms of silence', () => {
    const bursts = feed(createBurstGate(), [...times(50, quiet), ...times(40, loud), ...times(35, quiet)])
    expect(bursts).toHaveLength(1)
    // 300 ms pre-roll + 800 ms speech + 600 ms trailing silence
    expect(bursts[0].length).toBe((15 + 40 + 30) * FRAME)
  })

  it('keeps a phrase with a half-second pause in one burst', () => {
    const bursts = feed(createBurstGate(), [
      ...times(50, quiet),
      ...times(15, loud),
      ...times(25, quiet),
      ...times(30, loud),
      ...times(35, quiet),
    ])
    expect(bursts).toHaveLength(1)
    expect(bursts[0].length).toBe((15 + 15 + 25 + 30 + 30) * FRAME)
  })

  it('ignores clicks shorter than the minimum speech', () => {
    expect(feed(createBurstGate(), [...times(50, quiet), ...times(5, loud), ...times(30, quiet)])).toEqual([])
  })

  it('caps a long utterance at 2.5 s and waits for silence before the next burst', () => {
    const bursts = feed(createBurstGate(), [...times(50, quiet), ...times(300, loud), ...times(30, quiet)])
    expect(bursts).toHaveLength(1)
    expect(bursts[0].length).toBe(125 * FRAME)
  })

  it('listens only while the voice is idle', () => {
    expect(shouldListen({ listening: true }, 'idle')).toBe(true)
    expect(shouldListen({ listening: true }, 'error')).toBe(true)
    for (const state of ['listening', 'transcribing', 'thinking', 'speaking', 'muted'] as const)
      expect(shouldListen({ listening: true }, state)).toBe(false)
    expect(shouldListen({ listening: false }, 'idle')).toBe(false)
  })
})
