import type { ReactNode } from 'react'
import { Pressable, View, type AccessibilityRole } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon, type IconName } from '../icons'
import { AppText } from './Text'

/** One row of a group: an optional icon, a label with a subtitle, and a value or a chevron. */
export function Cell({
  label,
  sub,
  value,
  icon,
  leading,
  onPress,
  chevron,
  checked,
  tone = 'ink',
  center,
  disabled,
  role,
  accessibilityLabel,
  trailing,
}: {
  label: string
  sub?: string | null
  value?: string | null
  icon?: IconName
  leading?: ReactNode
  onPress?: () => void
  chevron?: boolean
  checked?: boolean
  tone?: 'ink' | 'brick' | 'brass'
  center?: boolean
  disabled?: boolean
  role?: AccessibilityRole
  accessibilityLabel?: string
  trailing?: ReactNode
}) {
  const { palette } = useTheme()
  const color = tone === 'brick' ? palette.brick : tone === 'brass' ? palette.brass : palette.ink
  const content = (
    <>
      {leading ??
        (icon ? (
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              backgroundColor: palette.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={icon} size={18} color={palette.ink} />
          </View>
        ) : null)}
      <View style={{ flex: center ? 0 : 1, minWidth: 0 }}>
        <AppText style={{ color, fontWeight: tone === 'ink' ? '400' : '600' }}>{label}</AppText>
        {sub ? (
          <AppText variant="sub" tone="muted">
            {sub}
          </AppText>
        ) : null}
      </View>
      {value ? (
        <AppText tone="muted" style={{ fontSize: 15 }} numberOfLines={1}>
          {value}
        </AppText>
      ) : null}
      {trailing}
      {checked ? <Icon name="check" size={20} color={palette.brass} /> : null}
      {chevron ? <Icon name="chev-right" size={18} color={palette.faint} /> : null}
    </>
  )
  const style = {
    minHeight: 50,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: center ? ('center' as const) : ('flex-start' as const),
    gap: 12,
  }
  if (!onPress)
    return (
      <View style={style} accessible={!!accessibilityLabel} accessibilityLabel={accessibilityLabel}>
        {content}
      </View>
    )
  return (
    <Pressable
      accessibilityRole={role ?? 'button'}
      accessibilityLabel={accessibilityLabel ?? [label, sub, value].filter(Boolean).join(', ')}
      aria-disabled={!!disabled}
      aria-checked={role === 'radio' || role === 'checkbox' ? !!checked : undefined}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [style, { backgroundColor: pressed ? palette.surface : 'transparent', opacity: disabled ? 0.45 : 1 }]}
    >
      {content}
    </Pressable>
  )
}
