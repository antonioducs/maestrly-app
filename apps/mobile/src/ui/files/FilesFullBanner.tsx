import type { FleetBot, FleetFilesUsage } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { View } from 'react-native'
import { filesCountLevel, filesLevel, formatSpace } from '../../fleet/files'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { mix } from '../../theme/tokens'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'

/** Above the message field while the bot cannot share more files: its space or its count is full. */
export function FilesFullBanner({ bot, usage }: { bot: FleetBot; usage: FleetFilesUsage | null }) {
  const { palette } = useTheme()
  const { t, locale } = useI18n()
  if (!usage || filesLevel(usage) !== 'full') return null
  const text =
    filesCountLevel(usage) === 'full'
      ? t('files.full.count', { name: bot.name, max: usage.countMax })
      : t('files.full.space', { free: formatSpace(Math.max(0, usage.quotaBytes - usage.usedBytes), locale) })
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginHorizontal: 12,
        marginBottom: 6,
        paddingVertical: 8,
        paddingLeft: 12,
        paddingRight: 8,
        borderRadius: 12,
        backgroundColor: mix(palette.brick, palette.raised, 0.12),
      }}
    >
      <Icon name="alert" size={18} color={palette.brick} />
      <AppText style={{ flex: 1, fontSize: 13.5, lineHeight: 18 }}>{text}</AppText>
      <Button
        size="sm"
        variant="secondary"
        label={t('files.full.action')}
        onPress={() => router.push({ pathname: '/bot-files/[id]', params: { id: bot.id, from: 'conversation' } })}
      />
    </View>
  )
}
