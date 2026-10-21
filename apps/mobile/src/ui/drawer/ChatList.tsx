import type { MobileConversation } from '@maestrly/bot-fleet-protocol'
import { memo } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { botChatLabel, groupByDay, isWaitingChat } from '../../chats/selectors'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { BotMark } from '../chat/BotMark'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'

/** A chat in the menu: its name, a spinner while it works and a dot when it waits on you. */
export const ChatRow = memo(function ChatRow({
  chat,
  current,
  onPress,
}: {
  chat: MobileConversation
  current: boolean
  onPress: () => void
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const waiting = isWaitingChat(chat)
  const bot = botChatLabel(chat, t)
  const state = chat.status === 'working' ? t('drawer.working') : waiting ? t('cue.eyebrow') : null
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[chat.name, bot, state].filter(Boolean).join(', ')}
      aria-selected={current}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 44,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: current || pressed ? palette.surface : 'transparent',
      })}
    >
      {chat.bot ? <BotMark size={20} /> : null}
      {chat.experience === 'maestro' ? <Icon name="sparkles" size={15} color={palette.muted} /> : null}
      <AppText numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 15.5 }}>
        {chat.name}
      </AppText>
      {chat.status === 'working' ? <ActivityIndicator size="small" color={palette.muted} /> : null}
      {waiting ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: palette.cue }} /> : null}
    </Pressable>
  )
})

/** Chats newest first, under the day of their latest activity. */
export function ChatList({
  chats,
  currentId,
  now,
  onOpen,
}: {
  chats: MobileConversation[]
  currentId: string | null
  now: number
  onOpen: (id: string) => void
}) {
  const { t } = useI18n()
  return (
    <View>
      {groupByDay(chats, now).map(({ group, chats: list }, index) => (
        <View key={group}>
          <AppText
            variant="label"
            tone="muted"
            accessibilityRole="header"
            style={{ paddingTop: index === 0 ? 10 : 16, paddingBottom: 4, paddingHorizontal: 10 }}
          >
            {t(`drawer.day.${group}`)}
          </AppText>
          {list.map((chat) => (
            <ChatRow key={chat.id} chat={chat} current={chat.id === currentId} onPress={() => onOpen(chat.id)} />
          ))}
        </View>
      ))}
    </View>
  )
}
