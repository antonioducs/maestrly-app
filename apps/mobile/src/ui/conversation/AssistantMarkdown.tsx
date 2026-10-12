import { memo, useEffect, useMemo, useRef } from 'react'
import { Animated, Platform, View } from 'react-native'
import { useMarkdown } from 'react-native-marked'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { useReducedMotion } from '../useReducedMotion'

function Caret() {
  const { palette } = useTheme()
  const reduced = useReducedMotion()
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 500, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: Platform.OS !== 'web' }),
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [opacity, reduced])
  return <Animated.View style={{ width: 9, height: 9, marginTop: 4, borderRadius: 5, backgroundColor: palette.ink, opacity }} />
}

/** A bot's reply, rendered from Markdown with the app's type and colors; a blinking dot while it streams. */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const { palette, scheme } = useTheme()
  const options = useMemo(
    () => ({
      colorScheme: scheme,
      theme: { colors: { code: palette.codeBg, link: palette.brass, text: palette.ink, border: palette.line } },
      styles: {
        text: { fontFamily: fonts.body, fontSize: 16, lineHeight: 24, color: palette.ink },
        strong: { fontFamily: fonts.bodySemi, fontWeight: '600' as const },
        paragraph: { marginTop: 0, marginBottom: 10, paddingVertical: 0 },
        li: { fontFamily: fonts.body, fontSize: 16, lineHeight: 24, color: palette.ink },
        list: { marginBottom: 10 },
        codespan: {
          fontFamily: fonts.mono,
          fontSize: 13,
          fontStyle: 'normal' as const,
          backgroundColor: palette.surface,
          color: palette.ink,
        },
        code: { backgroundColor: palette.codeBg, borderRadius: 12, padding: 12, marginBottom: 10 },
        codeText: { fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 20, color: palette.codeInk },
        link: { color: palette.brass, textDecorationLine: 'underline' as const },
        h1: { fontFamily: fonts.display, fontSize: 22, color: palette.ink },
        h2: { fontFamily: fonts.display, fontSize: 19, color: palette.ink },
        h3: { fontFamily: fonts.bodySemi, fontSize: 17, color: palette.ink },
      },
    }),
    [palette, scheme]
  )
  const elements = useMarkdown(text, options)
  return (
    <View>
      {elements.map((element, index) => (
        // Markdown blocks have no identity of their own; their order is stable while a reply streams.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <View key={index}>{element}</View>
      ))}
      {streaming ? <Caret /> : null}
    </View>
  )
})
