import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { Pressable, View } from 'react-native'
import { botStatusLine, statusLineText } from '../../fleet/selectors'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { BotAvatar } from '../Avatar'
import { IconButton } from '../primitives/IconButton'
import { AppText } from '../primitives/Text'

/** The top bar: the menu (with a dot when something waits on you), the open bot and what it is doing. */
export function ConversationHeader({
  bot,
  waiting,
  onOpenMenu,
}: {
  bot: FleetBot | null
  waiting: number
  onOpenMenu: () => void
}) {
  const { palette } = useTheme()
  const text = useI18n()
  const { t } = text
  const line = bot ? botStatusLine(bot, text) : null
  return (
    <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
      <IconButton
        icon="menu"
        label={waiting ? t('home.openMenuWaiting', { count: waiting }) : t('home.openMenu')}
        onPress={onOpenMenu}
        badge={
          waiting ? (
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: palette.cue, borderWidth: 2, borderColor: palette.canvas }} />
          ) : null
        }
      />
      <View style={{ flex: 1, alignItems: 'center', minWidth: 0 }}>
        {bot && line ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('conv.details', { name: bot.name, status: statusLineText(bot, line) })}
            onPress={() => router.push(`/bot-details/${bot.id}`)}
            style={({ pressed }) => ({
              maxWidth: '100%',
              alignItems: 'center',
              paddingVertical: 3,
              paddingHorizontal: 10,
              borderRadius: 12,
              backgroundColor: pressed ? palette.surface : 'transparent',
            })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '100%' }}>
              <BotAvatar bot={bot} size={26} />
              <AppText numberOfLines={1} style={{ fontFamily: fonts.display, fontSize: 17, lineHeight: 22, flexShrink: 1 }}>
                {bot.name}
              </AppText>
            </View>
            <AppText
              numberOfLines={1}
              variant={line.tone === 'mono' ? 'mono' : 'small'}
              tone={line.tone === 'cue' ? 'cue' : 'muted'}
              style={line.tone === 'cue' ? { fontFamily: fonts.bodySemi } : undefined}
            >
              {statusLineText(bot, line)}
            </AppText>
          </Pressable>
        ) : null}
      </View>
      <IconButton icon="compose" label={t('home.newChatSoon')} onPress={() => {}} disabled />
    </View>
  )
}
