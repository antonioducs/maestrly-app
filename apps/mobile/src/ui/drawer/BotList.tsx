import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { memo } from 'react'
import { Pressable, View } from 'react-native'
import type { EnvironmentGroup } from '../../fleet/selectors'
import { botStatusLine, statusLineText } from '../../fleet/selectors'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { BotAvatar } from '../Avatar'
import { AppText } from '../primitives/Text'

const BotRow = memo(function BotRow({
  bot,
  current,
  onPress,
  onLayoutY,
}: {
  bot: FleetBot
  current: boolean
  onPress: () => void
  onLayoutY: (y: number) => void
}) {
  const { palette } = useTheme()
  const text = useI18n()
  const line = botStatusLine(bot, text)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.name}, ${statusLineText(bot, line)}`}
      aria-selected={current}
      onPress={onPress}
      onLayout={(event) => onLayoutY(event.nativeEvent.layout.y)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingVertical: 6,
        paddingLeft: 6,
        paddingRight: 10,
        borderRadius: 12,
        backgroundColor: current || pressed ? palette.surface : 'transparent',
      })}
    >
      <BotAvatar bot={bot} size={40} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText numberOfLines={1} variant="bodyMedium">
          {bot.name}
        </AppText>
        <AppText
          numberOfLines={1}
          variant={line.tone === 'mono' ? 'mono' : 'small'}
          tone={line.tone === 'cue' ? 'cue' : 'muted'}
          style={line.tone === 'cue' ? { fontFamily: fonts.bodySemi } : undefined}
        >
          {statusLineText(bot, line)}
        </AppText>
      </View>
    </Pressable>
  )
})

/** Bots under the environment they run in, with how many there are and how many are working. */
export function BotList({
  groups,
  currentBotId,
  onOpen,
  onGroupLayout,
  onBotLayout,
}: {
  groups: EnvironmentGroup[]
  currentBotId: string | null
  onOpen: (botId: string) => void
  /** Where each group and row sits, so the drawer can scroll to the open bot. */
  onGroupLayout: (groupId: string, y: number) => void
  onBotLayout: (botId: string, groupId: string, y: number) => void
}) {
  const { plural, t } = useI18n()
  return (
    <View>
      {groups.map((group, index) => (
        <View key={group.id || 'loose'} onLayout={(event) => onGroupLayout(group.id, event.nativeEvent.layout.y)}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              gap: 6,
              paddingTop: index === 0 ? 10 : 16,
              paddingBottom: 6,
              paddingHorizontal: 10,
            }}
          >
            <AppText variant="label" tone="muted" accessibilityRole="header">
              {group.name}
            </AppText>
            <AppText variant="small" tone="faint">
              {[
                plural('bots.count', group.bots.length),
                group.working ? t('bots.working', { count: group.working }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </AppText>
          </View>
          {group.bots.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              current={bot.id === currentBotId}
              onPress={() => onOpen(bot.id)}
              onLayoutY={(y) => onBotLayout(bot.id, group.id, y)}
            />
          ))}
        </View>
      ))}
    </View>
  )
}
