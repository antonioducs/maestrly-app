import * as SplashScreen from 'expo-splash-screen'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, StyleSheet, useWindowDimensions } from 'react-native'
import Animated, {
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import Svg, { Defs, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg'
import { scheduleOnRN } from 'react-native-worklets'
import { prefs } from '../prefs'
import {
  BOTTOM_ARC,
  GLYPH_TRANSFORM,
  LEFT_FOOT,
  LETTERS,
  LOCKUP,
  M_PATH,
  MARK_BOX,
  RIGHT_FOOT,
  RING_STROKE,
  TOP_ARC,
} from './brand'
import { INTRO_LENGTH, type IntroKind, introKind, phase, RING_ARCS, ringArcPath } from './intro-motion'

/** The native splash's color (app.config.ts), so the intro takes over from it without a seam. */
const BACKGROUND = '#0f1110'
const INK = '#EDEAE3'
const BRASS = '#C9A86A'
const GLOW = '#E4BE72'
/** The glow around the ring: wide, faint strokes over the arcs, in the lockup's units. */
const HALO = [
  [48, 0.3],
  [84, 0.13],
  [130, 0.06],
] as const
const HALO_ROOM = 90

/**
 * Reanimated skips animations while the system reduces motion; the intro picks its still kind itself then, and its
 * clock and closing fade must still run.
 */
const STEADY = ReduceMotion.Never
const AnimatedPath = Animated.createAnimatedComponent(Path)
const OUT = Easing.bezierFn(0.22, 1, 0.36, 1)
const DRAW = Easing.bezierFn(0.6, 0, 0.2, 1)
const SLIDE = Easing.bezierFn(0.65, 0, 0.35, 1)

const LOCKUP_VIEWBOX = `0 0 ${LOCKUP.width} ${LOCKUP.height}`
const MARK_VIEWBOX = `${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.size} ${MARK_BOX.size}`
const HALO_BOX = MARK_BOX.size + 2 * HALO_ROOM
const HALO_VIEWBOX = `${MARK_BOX.x - HALO_ROOM} ${MARK_BOX.y - HALO_ROOM} ${HALO_BOX} ${HALO_BOX}`
/** How much bigger the mark starts, alone in the middle, before it slides into the lockup. */
const ALONE = 1.55

/**
 * The app's opening, over everything while the app gets ready, after the native splash (a plain dark screen). The first
 * time it plays whole, as in the brand video: two gold dots turn and stretch into the ring, the M comes in, the ring
 * glows, then the mark slides left as the wordmark comes in letter by letter. Later openings only bring the logo in;
 * with Reduce Motion on, it shows still. It fades into the app once it has played and the app is ready.
 */
export function Intro({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [kind, setKind] = useState<IntroKind | null>(null)
  const [played, setPlayed] = useState(false)
  const shown = useSharedValue(1)
  const { width, height } = useWindowDimensions()

  useEffect(() => {
    let alive = true
    void Promise.all([prefs.get('prefs.intro'), AccessibilityInfo.isReduceMotionEnabled().catch(() => false)]).then(
      ([seen, reduceMotion]) => {
        if (alive) setKind(introKind({ played: seen === 'played', reduceMotion }))
      }
    )
    return () => {
      alive = false
    }
  }, [])
  const finishPlaying = useCallback(() => setPlayed(true), [])
  useEffect(() => {
    if (played && kind === 'full') void prefs.set('prefs.intro', 'played')
  }, [played, kind])
  useEffect(() => {
    if (!played || !ready) return
    shown.value = withTiming(
      0,
      { duration: 280, easing: Easing.out(Easing.quad), reduceMotion: STEADY },
      (finished) => {
        'worklet'
        if (finished) scheduleOnRN(onDone)
      }
    )
  }, [played, ready, shown, onDone])

  const fade = useAnimatedStyle(() => ({ opacity: shown.value }))
  return (
    <Animated.View aria-hidden style={[styles.root, fade, { pointerEvents: played && ready ? 'none' : 'auto' }]}>
      {kind ? (
        <Lockup kind={kind} width={Math.min(width * 0.7, 320)} screen={{ width, height }} onPlayed={finishPlaying} />
      ) : null}
    </Animated.View>
  )
}

function Lockup({
  kind,
  width,
  screen,
  onPlayed,
}: {
  kind: IntroKind
  width: number
  screen: { width: number; height: number }
  onPlayed: () => void
}) {
  const clock = useSharedValue(0)
  const started = useRef(false)
  const unit = width / LOCKUP.width
  const height = LOCKUP.height * unit
  // The full intro draws the mark at its starting size and shrinks it, so it never scales a bitmap up.
  const peak = kind === 'full' ? ALONE : 1
  const markSize = MARK_BOX.size * unit * peak
  const markBox = {
    position: 'absolute' as const,
    left: (MARK_BOX.x + MARK_BOX.size / 2) * unit - markSize / 2,
    top: (MARK_BOX.y + MARK_BOX.size / 2) * unit - markSize / 2,
    width: markSize,
    height: markSize,
  }
  const travel = (LOCKUP.width / 2 - (MARK_BOX.x + MARK_BOX.size / 2)) * unit
  const haloSize = (markSize * HALO_BOX) / MARK_BOX.size

  const start = () => {
    if (started.current) return
    started.current = true
    void SplashScreen.hideAsync().catch(() => {})
    const length = INTRO_LENGTH[kind]
    clock.value = withTiming(length, { duration: length, easing: Easing.linear, reduceMotion: STEADY }, (finished) => {
      'worklet'
      if (finished) scheduleOnRN(onPlayed)
    })
  }

  const backdrop = useAnimatedStyle(() => ({ opacity: kind === 'still' ? 1 : phase(clock.value, 0, 400) }))
  const whole = useAnimatedStyle(() => {
    const t = clock.value
    if (kind !== 'short') return { opacity: 1, transform: [{ scale: 1 }] }
    return { opacity: OUT(phase(t, 0, 300)), transform: [{ scale: 0.94 + 0.06 * OUT(phase(t, 0, 600)) }] }
  })
  const mark = useAnimatedStyle(() => {
    const slide = kind === 'full' ? SLIDE(phase(clock.value, 1350, 700)) : 1
    return { transform: [{ translateX: travel * (1 - slide) }, { scale: 1 + (1 / peak - 1) * slide }] }
  })
  const ring = useAnimatedStyle(() => {
    const t = clock.value
    const turn = kind === 'full' ? OUT(phase(t, 100, 800)) : kind === 'short' ? OUT(phase(t, 0, 600)) : 1
    const from = kind === 'full' ? -55 : -25
    return { opacity: kind === 'full' ? phase(t, 0, 200) : 1, transform: [{ rotate: `${from * (1 - turn)}deg` }] }
  })
  // The dots start thick and thin out as they stretch into the ring.
  const topArc = useAnimatedProps(() => {
    const grow = kind === 'full' ? DRAW(phase(clock.value, 100, 850)) : 1
    return { d: ringArcPath(RING_ARCS[0], grow), strokeWidth: RING_STROKE * (2.4 - 1.4 * grow) }
  })
  const bottomArc = useAnimatedProps(() => {
    const grow = kind === 'full' ? DRAW(phase(clock.value, 100, 850)) : 1
    return { d: ringArcPath(RING_ARCS[1], grow), strokeWidth: RING_STROKE * (2.4 - 1.4 * grow) }
  })
  const halo = useAnimatedStyle(() => ({
    opacity: kind === 'full' ? Math.sin(Math.PI * phase(clock.value, 1000, 1100)) : 0,
  }))
  const feet = useAnimatedStyle(() => {
    const rise = kind === 'full' ? OUT(phase(clock.value, 480, 400)) : 1
    return { opacity: rise, transform: [{ translateY: (1 - rise) * markSize * 0.08 }] }
  })
  const glyph = useAnimatedStyle(() => {
    const pop = kind === 'full' ? OUT(phase(clock.value, 550, 450)) : 1
    return { opacity: pop, transform: [{ scale: 1.18 - 0.18 * pop }] }
  })

  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFill, backdrop]}>
        <Svg width={screen.width} height={screen.height} viewBox="0 0 100 100" preserveAspectRatio="none">
          <Defs>
            <RadialGradient id="intro-steel" cx="78" cy="22" r="55" gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor="#6e8296" stopOpacity={0.15} />
              <Stop offset="1" stopColor="#6e8296" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="intro-moss" cx="20" cy="82" r="50" gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor="#788769" stopOpacity={0.11} />
              <Stop offset="1" stopColor="#788769" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="100" height="100" fill="url(#intro-steel)" />
          <Rect width="100" height="100" fill="url(#intro-moss)" />
        </Svg>
      </Animated.View>
      <Animated.View style={[{ width, height }, whole]} onLayout={start}>
        {LETTERS.map((d, index) => (
          <Letter key={d.slice(0, 12)} d={d} index={index} kind={kind} clock={clock} size={{ width, height }} />
        ))}
        <Animated.View style={[markBox, mark]}>
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: (markSize - haloSize) / 2,
                top: (markSize - haloSize) / 2,
                width: haloSize,
                height: haloSize,
              },
              halo,
            ]}
          >
            <Svg width={haloSize} height={haloSize} viewBox={HALO_VIEWBOX}>
              {HALO.map(([strokeWidth, strokeOpacity]) => (
                <G key={strokeWidth} fill="none" stroke={GLOW} strokeWidth={strokeWidth} strokeOpacity={strokeOpacity}>
                  <Path d={TOP_ARC} strokeLinecap="round" />
                  <Path d={BOTTOM_ARC} strokeLinecap="round" />
                </G>
              ))}
            </Svg>
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, ring]}>
            <Svg width={markSize} height={markSize} viewBox={MARK_VIEWBOX}>
              <AnimatedPath animatedProps={topArc} fill="none" stroke={BRASS} strokeLinecap="round" />
              <AnimatedPath animatedProps={bottomArc} fill="none" stroke={BRASS} strokeLinecap="round" />
            </Svg>
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, feet]}>
            <Glyphs size={markSize} viewBox={MARK_VIEWBOX} paths={[LEFT_FOOT, RIGHT_FOOT]} />
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, glyph]}>
            <Glyphs size={markSize} viewBox={MARK_VIEWBOX} paths={[M_PATH]} />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </>
  )
}

/** One letter of the wordmark, sliding in from the right after the ones before it. */
function Letter({
  d,
  index,
  kind,
  clock,
  size,
}: {
  d: string
  index: number
  kind: IntroKind
  clock: SharedValue<number>
  size: { width: number; height: number }
}) {
  const shift = size.width * 0.06
  const style = useAnimatedStyle(() => {
    const enter = kind === 'full' ? OUT(phase(clock.value, 1900 + 55 * index, 600)) : 1
    return { opacity: enter, transform: [{ translateX: (1 - enter) * shift }] }
  })
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Glyphs size={size} viewBox={LOCKUP_VIEWBOX} paths={[d]} />
    </Animated.View>
  )
}

function Glyphs({
  size,
  viewBox,
  paths,
}: {
  size: number | { width: number; height: number }
  viewBox: string
  paths: readonly string[]
}) {
  const { width, height } = typeof size === 'number' ? { width: size, height: size } : size
  return (
    <Svg width={width} height={height} viewBox={viewBox}>
      <G transform={GLYPH_TRANSFORM} fill={INK} fillRule="evenodd">
        {paths.map((d) => (
          <Path key={d.slice(0, 12)} d={d} />
        ))}
      </G>
    </Svg>
  )
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    backgroundColor: BACKGROUND,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
