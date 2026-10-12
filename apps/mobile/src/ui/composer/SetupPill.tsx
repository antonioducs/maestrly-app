import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { Pressable } from 'react-native'
import { setupSummary } from '../../fleet/setup'
import { useBotSelections } from '../../fleet/use-selections'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'

/** The bot's setup in one pill: model and effort, a bolt for Fast and a red shield for full access. */
export function SetupPill({ bot }: { bot: FleetBot }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { option } = useBotSelections(bot)
  const full = bot.ceiling === 'full'
  const summary = setupSummary(bot, option, t)
  const spoken = [summary, bot.selection?.fastMode ? t('setup.fast') : null, full ? t('composer.fullAccess') : null]
    .filter(Boolean)
    .join(', ')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('composer.setup', { summary: spoken })}
      onPress={() => router.push(`/bot-setup/${bot.id}`)}
      hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => ({
        flexShrink: 1,
        minWidth: 0,
        height: 34,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginLeft: 2,
        paddingLeft: 9,
        paddingRight: 11,
        borderRadius: 17,
        backgroundColor: full ? mix(palette.brick, palette.raised, 0.13) : pressed ? palette.line : palette.surface,
      })}
    >
      {full ? <Icon name="shield" size={15} color={palette.brick} /> : null}
      <AppText numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.bodyMedium, fontSize: 13.5, lineHeight: 18 }}>
        {summary}
      </AppText>
      {bot.selection?.fastMode ? <Icon name="zap-fill" size={14} color={palette.brass} /> : null}
    </Pressable>
  )
}
