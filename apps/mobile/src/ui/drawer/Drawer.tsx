import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Animated, Easing, Keyboard, PanResponder, Pressable, useWindowDimensions, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { useReducedMotion } from '../useReducedMotion'

const EDGE = 24
const EASE = Easing.bezier(0.2, 0.7, 0.2, 1)

/**
 * The side menu, as in the prototype: the screen slides right to uncover the menu under it. It opens from the left
 * edge or the menu button, and closes by dragging left or tapping the screen. Only one side is ever readable by a
 * screen reader.
 */
export function Drawer({
  open,
  onOpenChange,
  panel,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  panel: ReactNode
  children: ReactNode
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const reduced = useReducedMotion()
  const { width } = useWindowDimensions()
  const panelWidth = Math.round(width * 0.84)
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current
  const state = useRef({ open, panelWidth, reduced, onOpenChange })
  state.current = { open, panelWidth, reduced, onOpenChange }

  const settle = (target: boolean) => {
    // Border radius cannot use the native driver, so the whole drawer moves on the JavaScript one.
    Animated.timing(progress, {
      toValue: target ? 1 : 0,
      duration: state.current.reduced ? 0 : 260,
      easing: EASE,
      useNativeDriver: false,
    }).start()
  }
  const settleRef = useRef(settle)
  settleRef.current = settle

  useEffect(() => {
    settleRef.current(open)
    // The keyboard of the message field would otherwise stay up over the menu and take its taps.
    if (open) Keyboard.dismiss()
  }, [open])

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => {
          const horizontal = Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5
          if (!horizontal) return false
          return state.current.open ? gesture.dx < 0 : gesture.x0 <= EDGE && gesture.dx > 0
        },
        onPanResponderMove: (_event, gesture) => {
          const base = state.current.open ? 1 : 0
          progress.setValue(Math.max(0, Math.min(1, base + gesture.dx / state.current.panelWidth)))
        },
        onPanResponderRelease: (_event, gesture) => {
          const base = state.current.open ? 1 : 0
          const position = base + gesture.dx / state.current.panelWidth
          const target = gesture.vx > 0.4 ? true : gesture.vx < -0.4 ? false : position > 0.5
          // Always animate to where the drawer settles, even when that is where it started.
          settleRef.current(target)
          if (target !== state.current.open) state.current.onOpenChange(target)
        },
        onPanResponderTerminate: () => settleRef.current(state.current.open),
      }),
    [progress]
  )

  const panelShift = progress.interpolate({ inputRange: [0, 1], outputRange: [-0.28 * panelWidth, 0] })
  const mainShift = progress.interpolate({ inputRange: [0, 1], outputRange: [0, panelWidth] })
  const corner = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 30] })

  return (
    <View style={{ flex: 1, overflow: 'hidden', backgroundColor: palette.drawer }} {...responder.panHandlers}>
      <Animated.View
        aria-hidden={!open}
        pointerEvents={open ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: panelWidth,
          backgroundColor: palette.drawer,
          transform: [{ translateX: panelShift }],
        }}
      >
        {panel}
      </Animated.View>
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          overflow: 'hidden',
          backgroundColor: palette.canvas,
          borderTopLeftRadius: corner,
          borderBottomLeftRadius: corner,
          transform: [{ translateX: mainShift }],
        }}
      >
        <View style={{ flex: 1 }} aria-hidden={open}>
          {children}
        </View>
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: palette.scrim,
            opacity: progress,
          }}
        />
        {open ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('drawer.closeMenu')}
            onPress={() => onOpenChange(false)}
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
          />
        ) : null}
      </Animated.View>
    </View>
  )
}
