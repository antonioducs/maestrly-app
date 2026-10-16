import type { ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { AppText } from '../primitives/Text'

export type WaitingEntry = { key: string; title: string; what: string; lead: ReactNode; onPress: () => void }

/** What waits on you, bots and chats, in one row that scrolls sideways so it never pushes the lists down. */
export function WaitingStrip({ items }: { items: WaitingEntry[] }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  if (items.length === 0) return null
  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 18,
          paddingTop: 10,
          paddingBottom: 6,
        }}
      >
        <AppText variant="label" tone="cue" accessibilityRole="header">
          {t('drawer.waiting')}
        </AppText>
        <View
          style={{
            minWidth: 20,
            height: 20,
            paddingHorizontal: 6,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.cue,
          }}
        >
          <AppText style={{ fontSize: 11.5, lineHeight: 14, fontWeight: '700', color: '#1f201e' }}>
            {items.length}
          </AppText>
        </View>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 4 }}
      >
        {items.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.what}`}
            onPress={item.onPress}
            style={({ pressed }) => ({
              maxWidth: 190,
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingVertical: 5,
              paddingLeft: 5,
              paddingRight: 12,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: palette.cue,
              backgroundColor: palette.cueSoft,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            })}
          >
            {item.lead}
            <View style={{ flexShrink: 1 }}>
              <AppText numberOfLines={1} style={{ fontSize: 14, lineHeight: 18, fontWeight: '600' }}>
                {item.title}
              </AppText>
              <AppText numberOfLines={1} tone="cue" style={{ fontSize: 12, lineHeight: 15, fontWeight: '600' }}>
                {item.what}
              </AppText>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}
