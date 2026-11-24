import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Animated, Easing, PanResponder, Platform, Pressable } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { useReducedMotion } from '../useReducedMotion'

const ACTION_WIDTH = 88
const FULL_SWIPE_RATIO = 0.6
const COLLAPSE_EASE = Easing.bezier(0.4, 0, 0.2, 1)
const nativeDriver = Platform.OS !== 'web'

export type SwipeDismissHandle = {
  dismiss: () => void
}

/**
 * Swipe-left-to-dismiss container for inbox rows: settles at -88pt to reveal Dismiss, commits automatically when
 * dragged past 60% of the row width, and collapses height/margin/opacity over 200ms before calling `onDismiss`.
 */
export function SwipeableInboxRow({
  open,
  onOpenChange,
  label,
  short,
  onDismiss,
  disabled,
  dismissRef,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
  short: string
  onDismiss: () => void
  disabled?: boolean
  dismissRef?: (handle: SwipeDismissHandle | null) => void
  children: ReactNode
}) {
  const { palette } = useTheme()
  const reduced = useReducedMotion()
  const x = useRef(new Animated.Value(0)).current
  const collapse = useRef(new Animated.Value(1)).current
  const [collapsing, setCollapsing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const widthRef = useRef(0)
  const heightRef = useRef(0)
  const committingRef = useRef(false)
  const openedRef = useRef(open)
  openedRef.current = open
  const changeRef = useRef(onOpenChange)
  changeRef.current = onOpenChange
  const dismissCallbackRef = useRef(onDismiss)
  dismissCallbackRef.current = onDismiss
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced

  const runCollapse = useCallback(() => {
    if (reducedRef.current || heightRef.current <= 0) {
      dismissCallbackRef.current()
      return
    }
    setCollapsing(true)
    collapse.setValue(1)
    Animated.timing(collapse, {
      toValue: 0,
      duration: 200,
      easing: COLLAPSE_EASE,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) dismissCallbackRef.current()
    })
  }, [collapse])

  const commitDismiss = useCallback(
    (slideOut: boolean) => {
      if (committingRef.current) return
      committingRef.current = true
      changeRef.current(false)
      if (reducedRef.current) {
        dismissCallbackRef.current()
        return
      }
      const width = widthRef.current
      if (slideOut && width > 0) {
        Animated.timing(x, {
          toValue: -width,
          duration: 120,
          easing: COLLAPSE_EASE,
          useNativeDriver: nativeDriver,
        }).start(() => runCollapse())
      } else {
        runCollapse()
      }
    },
    [runCollapse, x]
  )

  useEffect(() => {
    dismissRef?.({ dismiss: () => commitDismiss(false) })
    return () => dismissRef?.(null)
  }, [dismissRef, commitDismiss])

  const settle = useCallback(
    (next: boolean) => {
      if (committingRef.current) return
      const toValue = next ? -ACTION_WIDTH : 0
      if (reduced) x.setValue(toValue)
      else Animated.spring(x, { toValue, useNativeDriver: nativeDriver, bounciness: 0, speed: 18 }).start()
    },
    [reduced, x]
  )

  useEffect(() => settle(open), [open, settle])

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          !disabled &&
          !committingRef.current &&
          Math.abs(gesture.dx) > 10 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderGrant: () => {
          x.stopAnimation()
          setDragging(true)
        },
        onPanResponderMove: (_event, gesture) => {
          const base = openedRef.current ? -ACTION_WIDTH : 0
          const width = widthRef.current
          const min = width > 0 ? -width : -ACTION_WIDTH - 24
          x.setValue(Math.max(min, Math.min(0, base + gesture.dx)))
        },
        onPanResponderRelease: (_event, gesture) => {
          setDragging(false)
          const end = (openedRef.current ? -ACTION_WIDTH : 0) + gesture.dx
          const width = widthRef.current
          if (width > 0 && end < -width * FULL_SWIPE_RATIO) {
            commitDismiss(true)
            return
          }
          const next = gesture.vx < -0.4 || (gesture.vx <= 0.4 && end < -ACTION_WIDTH / 2)
          changeRef.current(next)
          settle(next)
        },
        onPanResponderTerminate: () => {
          setDragging(false)
          settle(openedRef.current)
        },
      }),
    [commitDismiss, disabled, settle, x]
  )

  // Hidden at rest so the brass action never peeks behind rounded corners or dimmed rows.
  const actionOpacity = x.interpolate({
    inputRange: [-ACTION_WIDTH, -1, 0],
    outputRange: [1, 1, 0],
    extrapolate: 'clamp',
  })

  const animatedContainerStyle = collapsing
    ? {
        height: collapse.interpolate({ inputRange: [0, 1], outputRange: [0, heightRef.current] }),
        marginBottom: collapse.interpolate({ inputRange: [0, 1], outputRange: [0, 2] }),
        opacity: collapse,
      }
    : { marginBottom: 2 }

  return (
    <Animated.View
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout
        if (!collapsing) {
          widthRef.current = width
          heightRef.current = height
        }
      }}
      style={[{ overflow: 'hidden', borderRadius: 12 }, animatedContainerStyle]}
    >
      <Animated.View
        aria-hidden={!open && !dragging}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        pointerEvents={open ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: ACTION_WIDTH,
          opacity: actionOpacity,
        }}
      >
        {open || dragging || collapsing ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => commitDismiss(false)}
            style={{
              flex: 1,
              backgroundColor: palette.brass,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
            }}
          >
            <Icon name="x" size={20} color={palette.canvas} />
            <AppText style={{ color: palette.canvas, fontFamily: fonts.bodySemi, fontSize: 13.5, lineHeight: 18 }}>
              {short}
            </AppText>
          </Pressable>
        ) : null}
      </Animated.View>
      <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: x }] }}>
        {children}
      </Animated.View>
    </Animated.View>
  )
}
