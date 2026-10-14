import { Pressable, View } from 'react-native'
import { useTheme } from '../../theme/ThemeProvider'
import { AppText } from '../primitives/Text'

export type Tab = { id: string; label: string; badge?: number; badgeLabel?: string }

/** The drawer's sections, as in the desktop sidebar. With one section there is nothing to switch, so nothing shows. */
export function TabBar({ tabs, value, onChange }: { tabs: Tab[]; value: string; onChange: (id: string) => void }) {
  const { palette } = useTheme()
  if (tabs.length < 2) return null
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        gap: 2,
        marginHorizontal: 14,
        marginTop: 10,
        marginBottom: 2,
        padding: 3,
        borderRadius: 12,
        backgroundColor: palette.surface,
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            aria-selected={selected}
            accessibilityLabel={tab.badge ? `${tab.label}, ${tab.badgeLabel ?? tab.badge}` : tab.label}
            onPress={() => onChange(tab.id)}
            hitSlop={{ top: 4, bottom: 4 }}
            style={{
              flex: 1,
              minHeight: 36,
              borderRadius: 9,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? palette.raised : 'transparent',
            }}
          >
            <AppText variant="label" tone={selected ? 'ink' : 'muted'} style={{ fontSize: 14 }}>
              {tab.label}
            </AppText>
            {tab.badge ? (
              <View
                style={{
                  position: 'absolute',
                  top: -5,
                  right: 2,
                  minWidth: 17,
                  height: 17,
                  paddingHorizontal: 5,
                  borderRadius: 9,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: palette.cue,
                }}
              >
                <AppText style={{ fontSize: 10.5, lineHeight: 13, fontWeight: '700', color: '#1f201e' }}>
                  {tab.badge}
                </AppText>
              </View>
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}
