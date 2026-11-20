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
  screens: [rect(3, 3, 8, 8, 1.5), rect(13, 3, 8, 8, 1.5), rect(3, 13, 8, 8, 1.5), rect(13, 13, 8, 8, 1.5)],
  inspect: [
    path(
      'M12.03 12.68a.5.5 0 0 1 .65-.65l9 3.5a.5.5 0 0 1-.03.94l-3.45 1.07a1 1 0 0 0-.66.66l-1.07 3.44a.5.5 0 0 1-.94.03z'
    ),
    path('M5 3a2 2 0 0 0-2 2'),
    path('M19 3a2 2 0 0 1 2 2'),
    path('M5 21a2 2 0 0 1-2-2'),
    path('M9 3h1'),
    path('M9 21h2'),
    path('M14 3h1'),
    path('M3 9v1'),
    path('M21 9v2'),
    path('M3 14v1'),
  ],
  tokens: [
    path(
      'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z'
    ),
    circle(13.5, 6.5, 0.5),
    circle(17.5, 10.5, 0.5),
    circle(6.5, 12.5, 0.5),
    circle(8.5, 7.5, 0.5),
  ],
  component: [
    path(
      'M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0z'
    ),
  ],
  main: [
    path(
      'M15.54 11.29a1 1 0 0 0 0 1.42l2.37 2.37a1 1 0 0 0 1.42 0l2.37-2.37a1 1 0 0 0 0-1.42l-2.37-2.37a1 1 0 0 0-1.42 0z'
    ),
    path(
      'M2.3 11.29a1 1 0 0 0 0 1.42l2.37 2.37a1 1 0 0 0 1.42 0l2.37-2.37a1 1 0 0 0 0-1.42L6.09 8.92a1 1 0 0 0-1.42 0z'
    ),
    path(
      'M8.92 17.91a1 1 0 0 0 0 1.42l2.37 2.37a1 1 0 0 0 1.42 0l2.37-2.37a1 1 0 0 0 0-1.42l-2.37-2.37a1 1 0 0 0-1.42 0z'
    ),
    path(
      'M8.92 4.67a1 1 0 0 0 0 1.42l2.37 2.37a1 1 0 0 0 1.42 0l2.37-2.37a1 1 0 0 0 0-1.42L12.71 2.3a1 1 0 0 0-1.42 0z'
    ),
  ],
  element: [
    path('M5 3a2 2 0 0 0-2 2'),
    path('M19 3a2 2 0 0 1 2 2'),
    path('M21 19a2 2 0 0 1-2 2'),
    path('M5 21a2 2 0 0 1-2-2'),
    path('M9 3h1'),
    path('M9 21h1'),
    path('M14 3h1'),
    path('M14 21h1'),
    path('M3 9v1'),
    path('M21 9v1'),
    path('M3 14v1'),
    path('M21 14v1'),
  ],
  minus: [path('M5 12h14')],
  plus: [path('M5 12h14'), path('M12 5v14')],
  arrow: [path('M5 12h14'), path('m13 6 6 6-6 6')],
  eye: [
    path('M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0'),
    circle(12, 12, 3),
  ],
  reset: [path('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'), path('M3 3v5h5')],
  search: [circle(11, 11, 7), path('m20 20-3.5-3.5')],
  alert: [
    path('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'),
    path('M12 9v4'),
    path('M12 17h.01'),
  ],
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
