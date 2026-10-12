import type { ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useI18n } from '../i18n'
import { useTheme } from '../theme/ThemeProvider'
import { Icon } from './icons'
import { AppText } from './primitives/Text'

/** A screen shown as a sheet: a title, a Done button (or Back inside the sheet), and scrolling groups. */
export function SheetScreen({
  title,
  onDone,
  back,
  children,
}: {
  title: string
  onDone: () => void
  back?: { label: string; onPress: () => void }
  children: ReactNode
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: palette.sheet }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingTop: 14, paddingHorizontal: 6 }}>
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
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <AppText variant="title" accessibilityRole="header" style={{ marginHorizontal: 4, marginBottom: 2 }}>
          {title}
        </AppText>
        {children}
      </ScrollView>
    </View>
  )
}
