import type { FleetBot, MobileConversation, MobileRuntime } from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { type ReactNode, useEffect, useRef } from 'react'
import { Animated, Easing, Platform, Pressable, View } from 'react-native'
import { botChatLabel, chatStatusLine } from '../../chats/selectors'
import { botStatusLine, statusLineText, type StatusLine } from '../../fleet/selectors'
import { useI18n } from '../../i18n'
import { useInbox } from '../../inbox'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { BotAvatar } from '../Avatar'
import { BotMark } from '../chat/BotMark'
import { Icon } from '../icons'
import { IconButton } from '../primitives/IconButton'
import { AppText } from '../primitives/Text'
import { useReducedMotion } from '../useReducedMotion'

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
  const text = useI18n()
  const line = chatStatusLine(chat, runtime, serverName, text)
  const bot = botChatLabel(chat, text.t)
  return (
    <TitleButton
      label={[text.t('chat.details', { name: chat.name, status: line.text }), bot].filter(Boolean).join(', ')}
      onPress={() => router.push(`/chat-setup/${chat.id}`)}
      name={chat.name}
      line={line}
      lead={chat.bot ? <BotMark size={22} /> : undefined}
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

const BADGE_EASE = Easing.bezier(0.4, 0, 0.2, 1)

function BellButton() {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { counts } = useInbox()
  const reduced = useReducedMotion()
  const count = counts.total
  const previousCount = useRef(count)
  const scale = useRef(new Animated.Value(1)).current

  useEffect(() => {
    const appeared = previousCount.current === 0 && count > 0
    previousCount.current = count
    if (!appeared || reduced) {
      scale.setValue(1)
      return
    }
    scale.setValue(0.6)
    Animated.timing(scale, {
      toValue: 1,
      duration: 160,
      easing: BADGE_EASE,
      useNativeDriver: Platform.OS !== 'web',
    }).start()
  }, [count, reduced, scale])

  const label = count > 0 ? t('inbox.openCount', { count }) : t('inbox.open')
  const badgeText = count > 99 ? '99+' : String(count)

  return (
    <IconButton
      icon="bell"
      label={label}
      onPress={() => router.push('/inbox')}
      style={{ overflow: 'visible', zIndex: 1 }}
    >
      {count > 0 ? (
        <Animated.View
          aria-hidden
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 4,
            left: 22,
            height: 22,
            minWidth: 22,
            borderRadius: 11,
            paddingHorizontal: 5,
            borderWidth: 2,
            borderColor: palette.canvas,
            backgroundColor: palette.badge,
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ scale }],
          }}
        >
          <AppText
            numberOfLines={1}
            style={{
              fontFamily: fonts.bodySemi,
              fontSize: 11.5,
              lineHeight: 14,
              color: palette.badgeInk,
              fontVariant: ['tabular-nums'],
            }}
          >
            {badgeText}
          </AppText>
        </Animated.View>
      ) : null}
    </IconButton>
  )
}

/** The top bar: menu, notifications bell, what is open, search and a new chat. */
export function ConversationHeader({
  title,
  onOpenMenu,
  onNewChat,
  onSearch = null,
}: {
  title: ReactNode
  onOpenMenu: () => void
  /** Null when the server has no chats. */
  onNewChat: (() => void) | null
  /** Opens or closes the search of the conversation shown; null when none is. */
  onSearch?: (() => void) | null
}) {
  const { t } = useI18n()
  const rightCount = (onSearch ? 1 : 0) + (onNewChat ? 1 : 0)
  return (
    <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
      <IconButton icon="menu" label={t('home.openMenu')} onPress={onOpenMenu} />
      <BellButton />
      <View style={{ flex: 1, alignItems: 'center', minWidth: 0 }}>{title}</View>
      {/* Keeps the title centered against the 88 pt left side while anchoring single actions to the right edge. */}
      {rightCount === 0 ? <View style={{ width: 88 }} /> : rightCount === 1 ? <View style={{ width: 44 }} /> : null}
      {onSearch ? <IconButton icon="search" label={t('search.open')} onPress={onSearch} /> : null}
      {onNewChat ? <IconButton icon="compose" label={t('chat.newChat')} onPress={onNewChat} /> : null}
    </View>
  )
}
