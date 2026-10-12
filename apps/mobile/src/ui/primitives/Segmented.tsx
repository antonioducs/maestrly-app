import { Pressable, View } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { AppText } from './Text'

/** A row of exclusive choices drawn by the app, never the system picker. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  const { palette } = useTheme()
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', gap: 2, padding: 3, borderRadius: 11, backgroundColor: palette.surface }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              minHeight: 36,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? palette.raised : 'transparent',
              shadowColor: '#000',
              shadowOpacity: selected ? 0.14 : 0,
              shadowRadius: 3,
              shadowOffset: { width: 0, height: 1 },
              elevation: selected ? 1 : 0,
            }}
          >
            <AppText variant="bodyMedium" tone={selected ? 'ink' : 'muted'} style={{ fontSize: 14 }}>
              {option.label}
            </AppText>
          </Pressable>
        )
      })}
    </View>
  )
}
