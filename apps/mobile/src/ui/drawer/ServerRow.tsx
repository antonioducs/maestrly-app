import { Pressable, View } from 'react-native'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'

/** The server the drawer shows, with whether it is reachable; it opens the list of paired servers. */
export function ServerRow({ name, online, onPress }: { name: string; online: boolean; onPress: () => void }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const state = t(online ? 'common.connected' : 'common.offline')
  const dot = online ? palette.moss : palette.brick
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('drawer.server', { name, state })}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginHorizontal: 8,
        marginTop: 6,
        paddingVertical: 8,
        paddingHorizontal: 10,
        minHeight: 48,
        borderRadius: 12,
        backgroundColor: pressed ? palette.surface : 'transparent',
      })}
    >
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: `${dot}38`,
        }}
      >
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText numberOfLines={1} style={{ fontSize: 15, lineHeight: 19, fontWeight: '600' }}>
          {name}
        </AppText>
        <AppText variant="small" tone="muted">
          {state}
        </AppText>
      </View>
      <Icon name="chev-right" size={18} color={palette.faint} />
    </Pressable>
  )
}
