import { useEffect, useRef } from 'react'
import type { RealtimeLevels } from './realtime-client'

/**
 * The voice screen's signature: five lines, like a staff, that carry the sound. Amber when they follow the person's
 * microphone, bone when they follow the assistant's voice, a ripple while it works, dotted while the microphone is off.
 */
/** `hearing`: the call's server hears the person, whatever the level; `listening`: amber only once they are loud. */
export type StaffMode = 'hearing' | 'listening' | 'speaking' | 'thinking' | 'connecting' | 'muted' | 'off' | 'error'

type Rgb = [number, number, number]
const COLORS: Record<'you' | 'voice' | 'idle' | 'muted' | 'error', Rgb> = {
  you: [242, 180, 92],
  voice: [237, 234, 227],
  idle: [154, 149, 140],
  muted: [92, 89, 84],
  error: [255, 122, 133],
}
/** Speech sits around 0.05–0.2 RMS: this maps it to the lines' full swing. */
const GAIN = 7
/** Above this the person is heard: the lines turn amber. */
const HEARD = 0.04
const REVEAL_MS = 850

/** A factor tuned per frame at 60 fps, for the frame time it really took. */
const perFrame = (factor: number, dt: number) => 1 - (1 - factor) ** (dt * 60)

export function VoiceStaff({
  mode,
  levels,
  compact = false,
  className,
}: {
  mode: StaffMode
  levels: () => RealtimeLevels
  compact?: boolean
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const props = useRef({ mode, levels })
  props.current = { mode, levels }

  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const viz = { level: 0, think: 0, color: [...COLORS.idle] as Rgb, t: 0, last: performance.now() }
    let revealFrom = props.current.mode === 'connecting' ? performance.now() : 0
    let lastMode = props.current.mode
    let frame = 0

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      const dt = Math.min(0.5, (now - viz.last) / 1000)
      viz.last = now
      const { mode: current, levels: read } = props.current
      if (current !== lastMode) {
        if (current === 'connecting') revealFrom = now
        lastMode = current
      }
      const { input, output } = read()
      let target = 0.035
      let tone: keyof typeof COLORS = 'idle'
      let think = 0
      if (current === 'speaking') {
        target = Math.max(0.12, Math.min(1, output * GAIN))
        tone = 'voice'
      } else if (current === 'hearing' || current === 'listening') {
        target = Math.max(current === 'hearing' ? 0.12 : 0.035, Math.min(1, input * GAIN))
        tone = current === 'hearing' || input > HEARD ? 'you' : 'idle'
      } else if (current === 'thinking') {
        target = 0.06
        think = 1
      } else if (current === 'connecting') target = 0.05
      else if (current === 'muted' || current === 'off') {
        target = 0
        tone = 'muted'
      } else {
        target = 0
        tone = 'error'
      }
      viz.level += (target - viz.level) * perFrame(target > viz.level ? 0.32 : 0.1, dt)
      viz.think += (think - viz.think) * perFrame(0.06, dt)
      const blend = perFrame(0.08, dt)
      viz.color = viz.color.map((value, i) => value + (COLORS[tone][i] - value) * blend) as Rgb
      viz.t += dt * (reduce.matches ? 0.25 : 0.8 + viz.level * 3)

      const dpr = window.devicePixelRatio || 1
      const w = element.clientWidth
      const h = element.clientHeight
      if (!w || !h) return
      if (element.width !== Math.round(w * dpr) || element.height !== Math.round(h * dpr)) {
        element.width = Math.round(w * dpr)
        element.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const [r, g, b] = viz.color.map(Math.round)
      const mid = h / 2
      const gap = compact ? 5.5 : Math.min(12, h / 9)
      const amp = (compact ? 12 : Math.min(40, h / 3.2)) * viz.level * (reduce.matches ? 0.6 : 1)
      const direction = tone === 'you' ? 1 : -1
      const padX = compact ? 2 : 28
      const span = w - padX * 2
      const live = current !== 'off' && current !== 'error'

      if (!compact && live) {
        const glow = ctx.createRadialGradient(w / 2, mid, 0, w / 2, mid, Math.min(w * 0.48, h * 0.5))
        glow.addColorStop(0, `rgba(${r},${g},${b},${0.04 + viz.level * 0.16})`)
        glow.addColorStop(1, `rgba(${r},${g},${b},0)`)
        ctx.fillStyle = glow
        ctx.fillRect(0, 0, w, h)
      }

      const reveal = current === 'connecting' ? Math.min(1, (now - revealFrom) / REVEAL_MS) : 1
      const from = padX + (span * (1 - reveal)) / 2
      const to = w - from
      ctx.setLineDash(current === 'muted' ? [2, 5] : [])
      for (let line = 0; line < 5; line++) {
        const offset = line - 2
        const y0 = mid + offset * gap
        const weight = 1 - Math.abs(offset) * 0.14
        const alpha = (live ? 0.32 : 0.16) + (live ? 0.62 : 0.14) * (1 - Math.abs(offset) / 2.6)
        ctx.beginPath()
        for (let x = from; x <= to; x += compact ? 2 : 3) {
          const u = (x - padX) / span
          const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, u))) ** 1.5
          const wave =
            Math.sin(u * 11 - viz.t * 2.1 * direction + line * 0.8) * 0.62 +
            Math.sin(u * 23 + viz.t * 3.3 + line * 1.9) * 0.38
          let y = y0 + amp * envelope * wave * weight
          if (viz.think > 0.01) {
            const head = ((viz.t * 0.22) % 1.4) - 0.2
            const bump = Math.exp(-((u - head) ** 2) / 0.006)
            y += viz.think * bump * (compact ? 4 : 9) * Math.sin(line * 1.3 + viz.t * 2)
          }
          if (x === from) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`
        ctx.lineWidth = offset === 0 ? (compact ? 1.4 : 1.7) : compact ? 1 : 1.15
        ctx.stroke()
      }
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [compact])

  return <canvas ref={canvas} aria-hidden="true" className={className} />
}
