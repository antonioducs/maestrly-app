import type { ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useI18n } from '../i18n'
import { useTheme } from '../theme/ThemeProvider'
import { Icon } from './icons'
import { AppText } from './primitives/Text'

/**
 * A screen shown as a sheet: a title, a Done button (or Back inside the sheet), and scrolling groups.
 *
 * The scroll view is the screen's only root, with the header as its first, sticky child. iOS form sheets resize a
 * scroll view that has a sibling and, on the new architecture, then place it at the top, over that sibling. So what
 * must stay in view while the groups scroll, such as the actions on a selection, goes in `accessory`, which sits in
 * the sticky header under the Done row.
 */
export function SheetScreen({
  title,
  onDone,
  back,
  accessory,
  children,
}: {
  title: string
  onDone: () => void
  back?: { label: string; onPress: () => void }
  /** Stays at the top, under the Done row, while the rest scrolls. */
  accessory?: ReactNode
  children: ReactNode
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.sheet }}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      stickyHeaderIndices={[0]}
      keyboardShouldPersistTaps="handled"
    >
      {/* A sticky header's own style moves to the wrapper React Native puts around it, which then gets only flex: 1,
          so the row is a child of the sticky view rather than the sticky view itself. */}
      <View collapsable={false} style={{ backgroundColor: palette.sheet }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            minHeight: 64,
            paddingTop: 20,
            paddingHorizontal: 6,
          }}
        >
          <View style={{ flex: 1, alignItems: 'flex-start' }}>
            {back ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={back.label}
                onPress={back.onPress}
                hitSlop={8}
                style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingRight: 8 }}
              >
                <Icon name="chev-left" size={22} color={palette.brass} />
                <AppText numberOfLines={1} style={{ color: palette.brass, fontWeight: '600' }}>
                  {back.label}
                </AppText>
              </Pressable>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.done')}
            onPress={onDone}
            hitSlop={8}
            style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}
          >
            <AppText style={{ color: palette.brass, fontWeight: '600' }}>{t('common.done')}</AppText>
          </Pressable>
        </View>
        {accessory ? <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>{accessory}</View> : null}
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <AppText variant="title" accessibilityRole="header" style={{ marginHorizontal: 4, marginBottom: 2 }}>
          {title}
        </AppText>
        {children}
      </View>
    </ScrollView>
  )
}
