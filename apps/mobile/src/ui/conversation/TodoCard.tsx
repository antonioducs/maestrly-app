import type { FleetTodo } from '@maestrly/bot-fleet-protocol'
import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { useReducedMotion } from '../useReducedMotion'

function DoingMark() {
  const { palette } = useTheme()
  const reduced = useReducedMotion()
  const spin = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduced) return
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
      })
    )
    loop.start()
    return () => loop.stop()
  }, [spin, reduced])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <Animated.View
      style={{
        width: 17,
        height: 17,
        borderRadius: 9,
        borderWidth: 1.5,
        borderColor: palette.ink,
        borderRightColor: 'transparent',
        transform: [{ rotate }],
      }}
    />
  )
}

/** The plan a bot keeps for its turn, with what is done, under way and left. */
export function TodoCard({ todos }: { todos: FleetTodo[] }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const done = todos.filter((todo) => todo.status === 'completed').length
  return (
    <View
      style={{
        paddingTop: 10,
        paddingHorizontal: 14,
        paddingBottom: 8,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.raised,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <AppText variant="label" tone="muted" accessibilityRole="header">
          {t('todo.title')}
        </AppText>
        <AppText variant="label" tone="muted">
          {t('todo.progress', { done, total: todos.length })}
        </AppText>
      </View>
      {todos.map((todo, index) => {
        const state = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'doing' : 'pending'
        return (
          <View
            key={`${index}:${todo.content}`}
            accessible
            accessibilityLabel={`${todo.content}, ${t(`todo.${state}`)}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}
          >
            {state === 'done' ? (
              <View
                style={{
                  width: 17,
                  height: 17,
                  borderRadius: 9,
                  backgroundColor: palette.moss,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="check" size={12} color={palette.canvas} strokeWidth={2.6} />
              </View>
            ) : state === 'doing' ? (
              <DoingMark />
            ) : (
              <View
                style={{ width: 17, height: 17, borderRadius: 9, borderWidth: 1.5, borderColor: palette.lineStrong }}
              />
            )}
            <AppText
              style={{
                flex: 1,
                fontSize: 14.5,
                lineHeight: 20,
                color: state === 'done' ? palette.muted : palette.ink,
                textDecorationLine: state === 'done' ? 'line-through' : 'none',
              }}
            >
              {todo.content}
            </AppText>
          </View>
        )
      })}
    </View>
  )
}
