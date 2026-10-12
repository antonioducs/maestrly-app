import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { memo, useEffect, useRef } from 'react'
import { Animated, Easing, Platform, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { useTheme } from '../theme/ThemeProvider'
import { fonts, mix } from '../theme/tokens'
import { useReducedMotion } from './useReducedMotion'

// The brand mark's open ring: a top arc and a bottom arc of one circle.
const TOP_ARC = 'M5.26 9.67A18 18 0 0 1 34.74 9.67'
const BOTTOM_ARC = 'M34.74 30.33A18 18 0 0 1 5.26 30.33'
const nativeDriver = Platform.OS !== 'web'

export type AvatarStatus = FleetBot['status']

/** A bot's initial inside the brand's open ring; the ring shows what the bot is doing. Decorative: rows say it. */
export const Avatar = memo(function Avatar({
  name,
  tint,
  status,
  size = 40,
}: {
  name: string
  tint: string
  status: AvatarStatus
  size?: number
}) {
  const { palette } = useTheme()
  const reduced = useReducedMotion()
  const spin = useRef(new Animated.Value(0)).current
  const breathe = useRef(new Animated.Value(1)).current
  const spinning = status === 'working' || status === 'starting'
  const waiting = status === 'waiting'

  useEffect(() => {
    spin.setValue(0)
    breathe.setValue(1)
    if (reduced) return
    let loop: Animated.CompositeAnimation | null = null
    if (spinning)
      loop = Animated.loop(
        Animated.timing(spin, {
          toValue: 1,
          duration: status === 'starting' ? 1100 : 2800,
          easing: Easing.linear,
          useNativeDriver: nativeDriver,
        })
      )
    else if (waiting)
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(breathe, { toValue: 0.45, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: nativeDriver }),
          Animated.timing(breathe, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: nativeDriver }),
        ])
      )
    loop?.start()
    return () => loop?.stop()
  }, [spin, breathe, spinning, waiting, status, reduced])

  const offline = status === 'offline'
  const stroke =
    status === 'working'
      ? tint
      : status === 'starting'
        ? palette.muted
        : waiting
          ? palette.cue
          : status === 'paused'
            ? palette.lineStrong
            : `${tint}52`
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          width: size * 0.74,
          height: size * 0.74,
          borderRadius: size,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: offline ? palette.surface : mix(tint, palette.raised, 0.2),
          opacity: offline ? 0.55 : 1,
        }}
      >
        <Animated.Text
          style={{
            fontFamily: fonts.display,
            fontSize: size * 0.34,
            lineHeight: size * 0.4,
            color: offline ? palette.muted : mix(tint, palette.ink, 0.78),
          }}
        >
          {name.slice(0, 1).toUpperCase()}
        </Animated.Text>
      </View>
      {offline ? null : (
        <Animated.View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            opacity: breathe,
            transform: [{ rotate }],
          }}
        >
          <Svg width={size} height={size} viewBox="0 0 40 40">
            {[TOP_ARC, BOTTOM_ARC].map((d) => (
              <Path
                key={d}
                d={d}
                fill="none"
                stroke={stroke}
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeDasharray={status === 'paused' ? [2, 3.2] : undefined}
              />
            ))}
          </Svg>
        </Animated.View>
      )}
    </View>
  )
})

export const BotAvatar = ({ bot, size }: { bot: FleetBot; size?: number }) => (
  <Avatar name={bot.name} tint={bot.tint} status={bot.status} size={size} />
)
