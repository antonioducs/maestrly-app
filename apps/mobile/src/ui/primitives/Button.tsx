import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon, type IconName } from '../icons'
import { AppText } from './Text'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'onDark'

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  disabled,
  busy,
  accessibilityLabel,
  style,
}: {
  label: string
  onPress: () => void
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: IconName
  disabled?: boolean
  busy?: boolean
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}) {
  const { palette } = useTheme()
  const background = {
    primary: palette.ink,
    secondary: palette.surface,
    ghost: 'transparent',
    danger: 'transparent',
    onDark: 'rgba(255,255,255,0.14)',
  }[variant]
  const color = {
    primary: palette.canvas,
    secondary: palette.ink,
    ghost: palette.muted,
    danger: palette.brick,
    onDark: '#ffffff',
  }[variant]
  const height = size === 'lg' ? 52 : size === 'sm' ? 34 : 44
  const inactive = disabled || busy
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      hitSlop={size === 'sm' ? 6 : 0}
      style={({ pressed }) => [
        {
          minHeight: height,
          paddingHorizontal: size === 'sm' ? 12 : 16,
          borderRadius: size === 'lg' ? 14 : size === 'sm' ? 9 : 12,
          backgroundColor: background,
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: palette.line,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed && !inactive ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 16 : 20} color={color} />
      ) : null}
      <View>
        <AppText
          style={{
            color,
            fontFamily: fonts.bodySemi,
            fontSize: size === 'lg' ? 17 : size === 'sm' ? 13.5 : 15.5,
            lineHeight: size === 'lg' ? 22 : 20,
          }}
        >
          {label}
        </AppText>
      </View>
    </Pressable>
  )
}
