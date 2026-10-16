import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOTTOM_ARC, LEFT_FOOT, LETTERS, M_PATH, RIGHT_FOOT, TOP_ARC } from '../src/ui/brand'
import { INTRO_LENGTH, introKind, phase, RING_ARCS, ringArcPath } from '../src/ui/intro-motion'

const brand = path.join(__dirname, '../../desktop/src/renderer/assets/brand')
const squash = (d: string) => d.replace(/\s+/g, ' ').trim()
/** The arcs, then the filled paths (in the SVG's order), of one of the desktop logos. */
function logo(file: string) {
  const svg = readFileSync(path.join(brand, file), 'utf8')
  const arcs = [...svg.matchAll(/<path d="([^"]+)" fill="none"/g)].map((match) => match[1])
  const glyphs = [...svg.matchAll(/<path d="([^"]+)"\/>/g)].map((match) => squash(match[1]))
  return { arcs, glyphs }
}
const numbers = (d: string) => d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []

describe('the logo', () => {
  it('draws the mark of the desktop brand assets, feet included', () => {
    const { arcs, glyphs } = logo('mark-full.svg')
    expect(arcs).toEqual([TOP_ARC, BOTTOM_ARC])
    expect([M_PATH, LEFT_FOOT, RIGHT_FOOT]).toEqual([glyphs[0], ...glyphs.slice(-2)])
  })

  it('spells the wordmark with the letters of the desktop lockup, from left to right', () => {
    const { glyphs } = logo('lockup-full.svg')
    expect(new Set([M_PATH, LEFT_FOOT, RIGHT_FOOT, ...LETTERS])).toEqual(new Set(glyphs))
    expect(LETTERS).toHaveLength(8)
    const starts = LETTERS.map((d) => numbers(d)[0])
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })
})

describe('the intro', () => {
  it('plays whole the first time, then shows the logo alone, and stays still when motion is reduced', () => {
    expect(introKind({ played: false, reduceMotion: false })).toBe('full')
    expect(introKind({ played: true, reduceMotion: false })).toBe('short')
    expect(introKind({ played: false, reduceMotion: true })).toBe('still')
    expect(INTRO_LENGTH.short).toBeLessThan(INTRO_LENGTH.full)
  })

  it('times steps from 0 to 1', () => {
    expect(phase(0, 100, 800)).toBe(0)
    expect(phase(500, 100, 800)).toBe(0.5)
    expect(phase(2000, 100, 800)).toBe(1)
  })

  it('grows each ring arc from its middle into the arc of the logo', () => {
    for (const [arc, official] of [
      [RING_ARCS[0], TOP_ARC],
      [RING_ARCS[1], BOTTOM_ARC],
    ] as const) {
      const whole = numbers(ringArcPath(arc, 1))
      const expected = numbers(official)
      for (const [index, value] of expected.entries()) expect(whole[index]).toBeCloseTo(value, 1)

      const [x0, y0, , , , , , x1, y1] = numbers(ringArcPath(arc, 0))
      expect(Math.hypot(x1 - x0, y1 - y0)).toBeLessThan(2)
      const middle = numbers(ringArcPath(arc, 0.5))
      expect((x0 + x1) / 2).toBeCloseTo((middle[0] + middle[7]) / 2, 0)
    }
  })
})
