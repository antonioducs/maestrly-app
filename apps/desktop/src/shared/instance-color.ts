function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return h >>> 0
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100
  const ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = ln - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

export interface InstanceColor {
  hex: string
  rgb: [number, number, number]
}

export function instanceColor(instanceId: string): InstanceColor {
  const h = hashString(instanceId) % 360
  const s = 68 + (hashString(instanceId + ':s') % 18)
  const l = 54 + (hashString(instanceId + ':l') % 10)
  const [r, g, b] = hslToRgb(h, s, l)
  const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  return { hex, rgb: [r, g, b] }
}

export function instanceBadgeStyle(instanceId: string): {
  borderColor: string
  backgroundColor: string
  color: string
} {
  const { rgb } = instanceColor(instanceId)
  const [r, g, b] = rgb
  return {
    borderColor: `rgba(${r}, ${g}, ${b}, 0.55)`,
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.18)`,
    color: `rgb(${Math.min(255, r + 30)}, ${Math.min(255, g + 30)}, ${Math.min(255, b + 30)})`,
  }
}
