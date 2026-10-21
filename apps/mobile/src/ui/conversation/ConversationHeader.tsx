import type { FleetBot, MobileConversation, MobileRuntime } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { botChatLabel, chatStatusLine } from '../../chats/selectors'
import { botStatusLine, statusLineText, type StatusLine } from '../../fleet/selectors'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { BotAvatar } from '../Avatar'
import { Icon } from '../icons'
import { IconButton } from '../primitives/IconButton'
import { AppText } from '../primitives/Text'

function TitleButton({
  label,
  onPress,
  name,
  line,
  lead,
  trail,
}: {
  label: string
  onPress: () => void
  name: string
  line: StatusLine
  lead?: ReactNode
  trail?: ReactNode
}) {
  const { palette } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
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
        {lead}
        <AppText numberOfLines={1} style={{ fontFamily: fonts.display, fontSize: 17, lineHeight: 22, flexShrink: 1 }}>
          {name}
        </AppText>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: '100%' }}>
        <AppText
          numberOfLines={1}
          variant={line.tone === 'mono' ? 'mono' : 'small'}
          tone={line.tone === 'cue' ? 'cue' : 'muted'}
          style={[{ flexShrink: 1 }, line.tone === 'cue' ? { fontFamily: fonts.bodySemi } : null]}
        >
          {line.text}
        </AppText>
        {trail}
      </View>
    </Pressable>
  )
}

export function BotTitle({ bot }: { bot: FleetBot }) {
  const text = useI18n()
  const line = botStatusLine(bot, text)
  const shown = { ...line, text: statusLineText(bot, line) }
  return (
    <TitleButton
      label={text.t('conv.details', { name: bot.name, status: shown.text })}
      onPress={() => router.push(`/bot-details/${bot.id}`)}
      name={bot.name}
      line={shown}
      lead={<BotAvatar bot={bot} size={26} />}
    />
  )
}

export function ChatTitle({
  chat,
  runtime,
  serverName,
}: {
  chat: MobileConversation
  runtime: MobileRuntime | null
  serverName: string
}) {
  const { palette } = useTheme()
  const text = useI18n()
  const line = chatStatusLine(chat, runtime, serverName, text)
  const bot = botChatLabel(chat, text.t)
  return (
    <TitleButton
      label={[text.t('chat.details', { name: chat.name, status: line.text }), bot].filter(Boolean).join(', ')}
      onPress={() => router.push(`/chat-setup/${chat.id}`)}
      name={chat.name}
      line={line}
      lead={chat.bot ? <Icon name="bot" size={18} color={palette.muted} /> : undefined}
    />
  )
}

export function NewChatTitle({ where }: { where: string }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <TitleButton
      label={t('chat.new.change', { where })}
      onPress={() => router.push('/new-chat')}
      name={t('chat.new.title')}
      line={{ text: where, tone: 'plain' }}
      trail={<Icon name="chev-down" size={12} color={palette.muted} />}
    />
  )
}

/** The top bar: the menu (with a dot when something waits on you), what is open, and a new chat. */
export function ConversationHeader({
  title,
  waiting,
  onOpenMenu,
  onNewChat,
  onSearch = null,
}: {
  title: ReactNode
  waiting: number
  onOpenMenu: () => void
  /** Null when the server has no chats. */
  onNewChat: (() => void) | null
  /** Opens or closes the search of the conversation shown; null when none is. */
  onSearch?: (() => void) | null
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
      <IconButton
        icon="menu"
        label={waiting ? t('home.openMenuWaiting', { count: waiting }) : t('home.openMenu')}
        onPress={onOpenMenu}
        badge={
          waiting ? (
            <View
              style={{
                width: 9,
                height: 9,
                borderRadius: 5,
                backgroundColor: palette.cue,
                borderWidth: 2,
                borderColor: palette.canvas,
              }}
            />
          ) : null
        }
      />
      {/* Keeps the title centered when the right side holds two buttons. */}
      {onSearch && onNewChat ? <View style={{ width: 44 }} /> : null}
      <View style={{ flex: 1, alignItems: 'center', minWidth: 0 }}>{title}</View>
      {onSearch ? <IconButton icon="search" label={t('search.open')} onPress={onSearch} /> : null}
      {onNewChat ? (
        <IconButton icon="compose" label={t('chat.newChat')} onPress={onNewChat} />
      ) : onSearch ? null : (
        <View style={{ width: 44 }} />
      )}
    </View>
  )
}
