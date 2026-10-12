import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { useTheme } from '../theme/ThemeProvider'
import { BrandMark } from './BrandMark'
import { Icon } from './icons'
import { useReducedMotion } from './useReducedMotion'

/** The app mark in the brand ring: it turns while pairing and shows a check once paired. */
export function PairingMark({ state }: { state: 'idle' | 'pairing' | 'done' }) {
  const { palette } = useTheme()
  const reduced = useReducedMotion()
  const spin = useRef(new Animated.Value(0)).current
  useEffect(() => {
    spin.setValue(0)
    if (state !== 'pairing' || reduced) return
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' })
    )
    loop.start()
    return () => loop.stop()
  }, [spin, state, reduced])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 132, height: 132, alignItems: 'center', justifyContent: 'center', marginBottom: 28, alignSelf: 'center' }}
    >
      <BrandMark size={84} radius={21} />
      <Animated.View style={{ position: 'absolute', width: 132, height: 132, transform: [{ rotate }] }}>
        <Svg width={132} height={132} viewBox="0 0 40 40">
          <Path d="M5.26 9.67A18 18 0 0 1 34.74 9.67" fill="none" stroke={palette.brass} strokeWidth={1.6} strokeLinecap="round" />
          <Path d="M34.74 30.33A18 18 0 0 1 5.26 30.33" fill="none" stroke={palette.brass} strokeWidth={1.6} strokeLinecap="round" />
        </Svg>
      </Animated.View>
      {state === 'done' ? (
        <View
          style={{
            position: 'absolute',
            right: 14,
            bottom: 14,
            width: 38,
            height: 38,
            borderRadius: 19,
            borderWidth: 4,
            borderColor: palette.canvas,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.moss,
          }}
        >
          <Icon name="check" size={18} color="#ffffff" />
        </View>
      ) : null}
    </View>
  )
}
