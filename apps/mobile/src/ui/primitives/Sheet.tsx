import type { ReactNode } from 'react'
import { Modal, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { useReducedMotion } from '../useReducedMotion'
import { AppText } from './Text'

/** A short sheet over the current screen, for a few choices; dismissed by tapping outside or the back gesture. */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const insets = useSafeAreaInsets()
  const reduced = useReducedMotion()
  return (
    <Modal visible={open} transparent animationType={reduced ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          onPress={onClose}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: palette.scrim }}
        />
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: palette.sheet,
            borderTopLeftRadius: 26,
            borderTopRightRadius: 26,
            paddingBottom: insets.bottom + 12,
            paddingHorizontal: 16,
          }}
        >
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: palette.lineStrong }} />
          </View>
          <AppText variant="title" accessibilityRole="header" style={{ marginHorizontal: 4, marginBottom: 10 }}>
            {title}
          </AppText>
          {children}
        </View>
      </View>
    </Modal>
  )
}
