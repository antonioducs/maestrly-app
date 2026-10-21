import { Pressable, View } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon, type IconName } from '../icons'
import { AppText } from './Text'

/** A row of exclusive choices drawn by the app, never the system picker. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  /** `count`: how many things the choice shows, after its label. */
  options: { value: T; label: string; icon?: IconName; count?: number }[]
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
            aria-checked={selected}
            accessibilityLabel={option.count === undefined ? option.label : `${option.label}, ${option.count}`}
            onPress={() => onChange(option.value)}
            hitSlop={4}
            style={{
              flex: 1,
              minHeight: option.icon ? 52 : 36,
              gap: 2,
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
            {option.icon ? <Icon name={option.icon} size={18} color={selected ? palette.ink : palette.muted} /> : null}
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <AppText
                variant="bodyMedium"
                tone={selected ? 'ink' : 'muted'}
                style={{ fontSize: option.icon ? 12.5 : 14, flexShrink: 1 }}
              >
                {option.label}
              </AppText>
              {option.count !== undefined ? (
                <AppText variant="mono" tone="faint" style={{ fontSize: 11.5 }}>
                  {option.count}
                </AppText>
              ) : null}
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}
