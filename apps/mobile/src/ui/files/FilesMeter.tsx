import type { FleetBot, FleetFilesUsage } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { Pressable, View } from 'react-native'
import { filesLevel, filesShare, formatSpace } from '../../fleet/files'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'

/** The bot's details: how full its space for shared files is, leading to its Files sheet. */
export function FilesMeter({ bot, usage }: { bot: FleetBot; usage: FleetFilesUsage | null }) {
  const { palette } = useTheme()
  const { t, locale } = useI18n()
  const level = filesLevel(usage)
  const share = usage ? filesShare(usage) : 0
  const sub =
    usage && usage.count > 0
      ? t('details.filesUsage', {
          used: formatSpace(usage.usedBytes, locale),
          quota: formatSpace(usage.quotaBytes, locale),
          count: usage.count,
          max: usage.countMax,
        })
      : t('details.filesNone')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t('details.files')}, ${sub}`}
      onPress={() => router.push({ pathname: '/bot-files/[id]', params: { id: bot.id } })}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 14,
        backgroundColor: pressed ? palette.surface : 'transparent',
      })}
    >
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
        <Icon name="folder" size={18} color={palette.ink} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText>{t('details.files')}</AppText>
        <View
          style={{ height: 6, marginTop: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: palette.surface }}
        >
          <View
            style={{
              width: `${Math.max(2, share * 100)}%`,
              height: 6,
              borderRadius: 3,
              backgroundColor: level === 'full' ? palette.brick : level === 'near' ? palette.cue : palette.brass,
            }}
          />
        </View>
        <AppText variant="sub" tone="muted" style={{ marginTop: 4 }}>
          {sub}
        </AppText>
      </View>
      <Icon name="chev-right" size={18} color={palette.faint} />
    </Pressable>
  )
}
