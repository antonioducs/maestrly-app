import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Animated, PanResponder, Pressable, View } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { useReducedMotion } from '../useReducedMotion'
import { AppText } from './Text'

const ACTION_WIDTH = 88

/** A row that slides left to reveal Delete; screen readers get the same action from the row itself. */
export function SwipeToDelete({
  open,
  onOpenChange,
  label,
  short,
  onDelete,
  disabled,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the revealed button says to a screen reader, such as "Delete report.pdf". */
  label: string
  /** What it shows under its icon, such as "Delete". */
  short: string
  onDelete: () => void
  disabled?: boolean
  children: ReactNode
}) {
  const { palette } = useTheme()
  const reduced = useReducedMotion()
  const x = useRef(new Animated.Value(0)).current
  const opened = useRef(open)
  opened.current = open
  // Read when a swipe ends: a new callback on each render of the list must not rebuild the gesture under the finger.
  const change = useRef(onOpenChange)
  change.current = onOpenChange
  const settle = useCallback(
    (next: boolean) => {
      const toValue = next ? -ACTION_WIDTH : 0
      if (reduced) x.setValue(toValue)
      else Animated.spring(x, { toValue, useNativeDriver: true, bounciness: 0, speed: 18 }).start()
    },
    [reduced, x]
  )
  useEffect(() => settle(open), [open, settle])
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          !disabled && Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderGrant: () => x.stopAnimation(),
        onPanResponderMove: (_event, gesture) => {
          const base = opened.current ? -ACTION_WIDTH : 0
          x.setValue(Math.max(-ACTION_WIDTH - 24, Math.min(0, base + gesture.dx)))
        },
        onPanResponderRelease: (_event, gesture) => {
          const end = (opened.current ? -ACTION_WIDTH : 0) + gesture.dx
          const next = gesture.vx < -0.4 || (gesture.vx <= 0.4 && end < -ACTION_WIDTH / 2)
          change.current(next)
          settle(next)
        },
        onPanResponderTerminate: () => settle(opened.current),
      }),
    [disabled, settle, x]
  )
  // Hidden at rest: an action drawn under the row would show at its edges.
  const actionOpacity = x.interpolate({ inputRange: [-ACTION_WIDTH, -1, 0], outputRange: [1, 1, 0] })
  return (
    <View style={{ overflow: 'hidden' }}>
      <Animated.View
        aria-hidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        pointerEvents={open ? 'auto' : 'none'}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: ACTION_WIDTH, opacity: actionOpacity }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onDelete}
          style={{
            flex: 1,
            backgroundColor: palette.brick,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
          }}
        >
          <Icon name="trash" size={20} color="#ffffff" />
          <AppText style={{ color: '#ffffff', fontFamily: fonts.bodySemi, fontSize: 13.5 }}>{short}</AppText>
        </Pressable>
      </Animated.View>
      <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: x }] }}>
        {children}
      </Animated.View>
    </View>
  )
}
