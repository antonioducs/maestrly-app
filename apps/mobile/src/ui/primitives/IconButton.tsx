import type { ReactNode } from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon, type IconName } from '../icons'

/** A 44-point square button with only an icon; `label` is what screen readers say. */
export function IconButton({
  icon,
  label,
  onPress,
  color,
  size = 22,
  disabled,
  badge,
  style,
}: {
  icon: IconName
  label: string
  onPress: () => void
  color?: string
  size?: number
  disabled?: boolean
  /** A dot on the corner, such as the amber one when something waits on you. */
  badge?: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const { palette } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={!!disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 44,
          height: 44,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? palette.surface : 'transparent',
          opacity: disabled ? 0.35 : 1,
        },
        style,
      ]}
    >
      <Icon name={icon} size={size} color={color ?? palette.ink} />
      {badge ? <View style={{ position: 'absolute', top: 9, right: 8 }}>{badge}</View> : null}
    </Pressable>
  )
}
