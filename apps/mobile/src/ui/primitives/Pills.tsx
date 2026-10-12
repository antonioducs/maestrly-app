import { Pressable, View } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { AppText } from './Text'

/** Exclusive choices that wrap onto more lines, such as a model's effort levels. */
export function Pills<T extends string | null>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const { palette } = useTheme()
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 12 }}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: !!disabled }}
            accessibilityLabel={option.label}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            hitSlop={4}
            style={{
              minHeight: 36,
              paddingHorizontal: 14,
              borderRadius: 18,
              justifyContent: 'center',
              backgroundColor: selected ? palette.ink : palette.surface,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <AppText variant="bodyMedium" tone={selected ? 'inverse' : 'ink'} style={{ fontSize: 14.5 }}>
              {option.label}
            </AppText>
          </Pressable>
        )
      })}
    </View>
  )
}
