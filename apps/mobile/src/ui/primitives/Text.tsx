import { Text as NativeText, type TextProps } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, type Palette } from '../../theme/tokens'

export type TextVariant = 'display' | 'title' | 'heading' | 'body' | 'bodyMedium' | 'label' | 'sub' | 'small' | 'mono'

const VARIANTS = {
  display: { fontFamily: fonts.display, fontSize: 34, lineHeight: 36, letterSpacing: -0.8 },
  title: { fontFamily: fonts.display, fontSize: 22, lineHeight: 27, letterSpacing: -0.3 },
  heading: { fontFamily: fonts.bodySemi, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: fonts.body, fontSize: 16, lineHeight: 23 },
  bodyMedium: { fontFamily: fonts.bodyMedium, fontSize: 15.5, lineHeight: 21 },
  label: { fontFamily: fonts.bodySemi, fontSize: 13, lineHeight: 17 },
  sub: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  small: { fontFamily: fonts.body, fontSize: 12.5, lineHeight: 17 },
  mono: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
} as const

export type TextTone = 'ink' | 'muted' | 'faint' | 'brass' | 'cue' | 'brick' | 'moss' | 'inverse'
const toneColor = (palette: Palette, tone: TextTone) =>
  tone === 'cue' ? palette.cueInk : tone === 'inverse' ? palette.canvas : palette[tone]

/** Text in the app's type scale; system font scaling stays on. */
export function AppText({
  variant = 'body',
  tone = 'ink',
  style,
  ...props
}: TextProps & { variant?: TextVariant; tone?: TextTone }) {
  const { palette } = useTheme()
  return <NativeText {...props} style={[VARIANTS[variant], { color: toneColor(palette, tone) }, style]} />
}
