/** The app's colors, taken from the approved prototype (which follows apps/web/src/styles/tokens.css). */
export type Palette = {
  canvas: string
  surface: string
  raised: string
  drawer: string
  sheet: string
  group: string
  ink: string
  muted: string
  faint: string
  line: string
  lineStrong: string
  brass: string
  brassSoft: string
  cue: string
  cueInk: string
  cueSoft: string
  moss: string
  brick: string
  codeBg: string
  codeInk: string
  scrim: string
}

export const palettes: { light: Palette; dark: Palette } = {
  light: {
    canvas: '#f6f5f1',
    surface: '#eeede8',
    raised: '#ffffff',
    drawer: '#efeee9',
    sheet: '#f3f2ee',
    group: '#ffffff',
    ink: '#1f201e',
    muted: '#656760',
    faint: '#8d8f87',
    line: '#e3e2da',
    lineStrong: '#c9c8be',
    brass: '#7d6229',
    brassSoft: '#f0e7d2',
    cue: '#e0a83a',
    cueInk: '#8a5b06',
    cueSoft: '#fcf3e0',
    moss: '#2b7a58',
    brick: '#b34a4d',
    codeBg: '#1b1d1b',
    codeInk: '#e7e4dc',
    scrim: 'rgba(20,22,21,0.34)',
  },
  dark: {
    canvas: '#141615',
    surface: '#222524',
    raised: '#1d201e',
    drawer: '#0f1110',
    sheet: '#1a1d1b',
    group: '#242826',
    ink: '#ece9e1',
    muted: '#9ea298',
    faint: '#73776f',
    line: '#2f3330',
    lineStrong: '#474c48',
    brass: '#d4b273',
    brassSoft: '#33301f',
    cue: '#f2bd52',
    cueInk: '#f2bd52',
    cueSoft: '#2b2416',
    moss: '#63d19c',
    brick: '#ff8288',
    codeBg: '#0c0d0c',
    codeInk: '#e7e4dc',
    scrim: 'rgba(0,0,0,0.52)',
  },
}

export const fonts = {
  display: 'BricolageGrotesque_600SemiBold',
  body: 'InstrumentSans_400Regular',
  bodyMedium: 'InstrumentSans_500Medium',
  bodySemi: 'InstrumentSans_600SemiBold',
  mono: 'JetBrainsMono_400Regular',
} as const

export const radius = { s: 6, m: 10, l: 16, xl: 24 } as const

/** Mixes `color` into `base` like CSS `color-mix(in srgb, color amount%, base)`, for hex colors. */
export function mix(color: string, base: string, amount: number): string {
  const parse = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
  const a = parse(color)
  const b = parse(base)
  const channel = (i: number) =>
    Math.round(a[i] * amount + b[i] * (1 - amount))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}
