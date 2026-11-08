import { describe, expect, it } from 'vitest'
import { createEndOfSpeechDetector, type EndOfSpeech } from '../../src/renderer/lib/end-of-speech'

const FRAME = 50

/** Feeds `segments` of [rms, durationMs] at 50 ms frames; returns the first verdict other than continue. */
function run(
  segments: Array<[number, number]>,
  opts?: Parameters<typeof createEndOfSpeechDetector>[0]
): { verdict: EndOfSpeech; atMs: number } {
  const detector = createEndOfSpeechDetector(opts)
  let at = 0
  for (const [rms, duration] of segments) {
    for (let t = 0; t < duration; t += FRAME, at += FRAME) {
      const verdict = detector.feed(rms, at)
      if (verdict !== 'continue') return { verdict, atMs: at }
    }
  }
  return { verdict: 'continue', atMs: at }
}

describe('end of speech', () => {
  it('ends 900 ms after the speech that followed quiet noise', () => {
    // 300 ms of room noise, 1.2 s of speech (last loud frame at 1450 ms), then silence.
    const result = run([
      [0.004, 300],
      [0.08, 1200],
      [0.004, 3000],
    ])
    expect(result).toEqual({ verdict: 'end', atMs: 1450 + 900 })
  })

  it('answers no-speech at 6 s when nobody spoke', () => {
    expect(run([[0.003, 10_000]])).toEqual({ verdict: 'no-speech', atMs: 6000 })
  })

  it('does not take a constant noise for speech', () => {
    // A fan as loud as quiet speech, from the start: the threshold sits above it.
    expect(run([[0.05, 10_000]])).toEqual({ verdict: 'no-speech', atMs: 6000 })
  })

  it('does not count a sound shorter than 150 ms as speech', () => {
    const result = run([
      [0.004, 300],
      [0.2, 100],
      [0.004, 8000],
    ])
    expect(result).toEqual({ verdict: 'no-speech', atMs: 6000 })
  })

  it('keeps listening through pauses shorter than the silence', () => {
    const result = run([
      [0.004, 300],
      [0.08, 500],
      [0.004, 600],
      [0.08, 500],
      [0.004, 2000],
    ])
    // The second phrase's last loud frame is at 300 + 500 + 600 + 450 = 1850 ms.
    expect(result).toEqual({ verdict: 'end', atMs: 1850 + 900 })
  })

  it('stops at the length limit while the person keeps talking', () => {
    expect(
      run(
        [
          [0.004, 300],
          [0.1, 70_000],
        ],
        { maxMs: 60_000 }
      )
    ).toEqual({ verdict: 'max', atMs: 60_000 })
  })

  it('never lets the threshold fall under the floor in a silent room', () => {
    const detector = createEndOfSpeechDetector()
    for (let at = 0; at <= 400; at += FRAME) detector.feed(0, at)
    expect(detector.threshold).toBe(0.01)
    // 0.009 is still under the floor: not speech.
    expect(
      run([
        [0, 300],
        [0.009, 8000],
      ]).verdict
    ).toBe('no-speech')
  })

  it('takes a fixed threshold without calibrating', () => {
    const result = run(
      [
        [0.3, 200],
        [0.0, 2000],
      ],
      { threshold: 0.1, silenceMs: 500 }
    )
    expect(result).toEqual({ verdict: 'end', atMs: 150 + 500 })
  })
})
