// Line icons, drawn with SVG elements: no markup is parsed.

type Shape = [tag: 'path' | 'rect' | 'circle', attributes: Record<string, string>]

const path = (d: string): Shape => ['path', { d }]
const rect = (x: number, y: number, width: number, height: number, rx = 2): Shape => [
  'rect',
  { x: String(x), y: String(y), width: String(width), height: String(height), rx: String(rx) },
]
const circle = (cx: number, cy: number, r: number): Shape => [
  'circle',
  { cx: String(cx), cy: String(cy), r: String(r) },
]

const ICONS = {
  artifact: [rect(2, 4, 20, 16), path('M2 8h20'), path('M6 4v4'), path('M10 4v4')],
  comment: [path('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
  left: [path('m15 18-6-6 6-6')],
  right: [path('m9 18 6-6-6-6')],
  down: [path('m6 9 6 6 6-6')],
  up: [path('m18 15-6-6-6 6')],
  check: [path('M20 6 9 17l-5-5')],
  close: [path('M18 6 6 18'), path('m6 6 12 12')],
  more: [circle(12, 12, 1), circle(19, 12, 1), circle(5, 12, 1)],
  link: [
    path('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'),
    path('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
  ],
  desktop: [rect(2, 3, 20, 14), path('M8 21h8'), path('M12 17v4')],
  tablet: [rect(4, 2, 16, 20), path('M12 18h.01')],
  phone: [rect(5, 2, 14, 20), path('M12 18h.01')],
  panel: [rect(3, 3, 18, 18), path('M15 3v18')],
  reload: [
    path('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'),
    path('M21 3v5h-5'),
    path('M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'),
    path('M8 16H3v5'),
  ],
  full: [
    path('M8 3H5a2 2 0 0 0-2 2v3'),
    path('M21 8V5a2 2 0 0 0-2-2h-3'),
    path('M3 16v3a2 2 0 0 0 2 2h3'),
    path('M16 21h3a2 2 0 0 0 2-2v-3'),
  ],
  trash: [
    path('M3 6h18'),
    path('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'),
    path('M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'),
  ],
  send: [path('m5 12 7-7 7 7'), path('M12 19V5')],
  copy: [rect(8, 8, 14, 14), path('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')],
  leave: [path('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), path('m16 17 5-5-5-5'), path('M21 12H9')],
  spark: [
    path(
      'M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z'
    ),
  ],
  user: [path('M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'), circle(12, 7, 4)],
} satisfies Record<string, Shape[]>

export type IconName = keyof typeof ICONS

const SVG = 'http://www.w3.org/2000/svg'

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }))
    svg.setAttribute(key, value)
  for (const [tag, attributes] of ICONS[name]) {
    const shape = document.createElementNS(SVG, tag)
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value)
    svg.append(shape)
  }
  return svg
}
