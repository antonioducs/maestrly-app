import { BOTTOM_ARC, TOP_ARC } from './brand'

/** How the app opens: the whole intro the first time, then the logo alone; still while the system reduces motion. */
export type IntroKind = 'full' | 'short' | 'still'

export function introKind({ played, reduceMotion }: { played: boolean; reduceMotion: boolean }): IntroKind {
  if (reduceMotion) return 'still'
  return played ? 'short' : 'full'
}

/** How long each kind plays, in milliseconds; the app then shows as soon as it is ready. */
export const INTRO_LENGTH: Record<IntroKind, number> = { full: 2900, short: 600, still: 500 }

/** How far along, from 0 to 1, a step that starts at `start` and lasts `length` milliseconds is at `time`. */
export function phase(time: number, start: number, length: number): number {
  'worklet'
  return Math.min(1, Math.max(0, (time - start) / length))
}

export type RingArc = { cx: number; cy: number; radius: number; from: number; to: number }

/** A ring arc of the logo (`M x y A r r 0 0 1 x y`) as its circle and angles, so it can be drawn part of the way. */
export function ringArc(path: string): RingArc {
  const [x0, y0, radius, , , , , x1, y1] = path.replace(/[MA]/g, ' ').trim().split(/\s+/).map(Number)
  const chord = Math.hypot(x1 - x0, y1 - y0)
  // The arc turns clockwise, so its center is on the right of the chord.
  const rise = Math.sqrt(radius * radius - (chord / 2) ** 2) / chord
  const cx = (x0 + x1) / 2 - (y1 - y0) * rise
  const cy = (y0 + y1) / 2 + (x1 - x0) * rise
  return { cx, cy, radius, from: Math.atan2(y0 - cy, x0 - cx), to: Math.atan2(y1 - cy, x1 - cx) }
}

export const RING_ARCS = [ringArc(TOP_ARC), ringArc(BOTTOM_ARC)] as const

/**
 * The arc drawn `progress` of the way, growing from its middle towards both ends. Near 0 it is a dot: a sliver the
 * stroke's round caps close into a circle.
 */
export function ringArcPath(arc: RingArc, progress: number): string {
  'worklet'
  const middle = (arc.from + arc.to) / 2
  const half = Math.max(((arc.to - arc.from) / 2) * progress, 0.002)
  const point = (angle: number) =>
    `${(arc.cx + arc.radius * Math.cos(angle)).toFixed(2)} ${(arc.cy + arc.radius * Math.sin(angle)).toFixed(2)}`
  return `M ${point(middle - half)} A ${arc.radius} ${arc.radius} 0 0 1 ${point(middle + half)}`
}
