import type { FleetBot, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { Redirect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, type TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChats } from '../chats/react'
import { waitingChats } from '../chats/selectors'
import { allConversations, type ChatsState } from '../chats/state'
import { DEMO_SERVER } from '../demo/demo-source'
import { useFleet, useFleetController } from '../fleet/react'
import { isComposerLocked } from '../fleet/selectors'
import type { FleetState } from '../fleet/state'
import { useI18n } from '../i18n'
import { useServers, type Current } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { ChatConversation } from '../ui/chat/ChatConversation'
import { NewChat } from '../ui/chat/NewChat'
import { Composer } from '../ui/composer/Composer'
import { LockedNotice } from '../ui/composer/LockedNotice'
import { ConnectionBanner } from '../ui/ConnectionBanner'
import { BotTitle, ChatTitle, ConversationHeader, NewChatTitle } from '../ui/conversation/ConversationHeader'
import { ConversationContext, type ConversationContextValue } from '../ui/conversation/CueCard'
import { Transcript } from '../ui/conversation/Transcript'
import { Drawer } from '../ui/drawer/Drawer'
import { DrawerPanel } from '../ui/drawer/DrawerPanel'
import { Icon } from '../ui/icons'
import { AppText } from '../ui/primitives/Text'

const selectOnline = (state: FleetState) => state.connection === 'open'

function EmptyState({ chats }: { chats: boolean }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 8 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          backgroundColor: palette.surface,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
        }}
      >
        <Icon name={chats ? 'message' : 'bot'} size={28} color={palette.muted} />
      </View>
      <AppText variant="title" accessibilityRole="header" style={{ textAlign: 'center' }}>
        {chats ? t('home.empty.titleChats') : t('home.empty.title')}
      </AppText>
      <AppText tone="muted" style={{ textAlign: 'center' }}>
        {chats ? t('home.empty.bodyChats') : t('home.empty.body')}
      </AppText>
    </View>
  )
}

function BotConversation({ bot }: { bot: FleetBot }) {
  const controller = useFleetController()
  const { active } = useServers()
  const online = useFleet(selectOnline)
  const inbox = useFleet(
    useCallback((state: FleetState) => state.inbox.filter((item) => item.botId === bot.id), [bot.id])
  )
  const input = useRef<TextInput>(null)
  const focusComposer = useCallback(() => input.current?.focus(), [])
  const context = useMemo<ConversationContextValue>(
    () => ({
      bot,
      name: bot.name,
      online,
      focusComposer,
      interactionFor: (item: FleetTranscriptItem) =>
        inbox.find((entry) => entry.interaction.itemId === item.id)?.interaction.id ?? null,
      resolve: (interactionId, resolution) => controller.resolve(bot.id, interactionId, resolution),
      imageSource: (imageId) => controller.source.imageSource(bot.id, imageId),
      files: {
        serverId: controller.source.serverId,
        botId: bot.id,
        demo: active?.id === DEMO_SERVER.id,
        source: (fileId) => controller.source.fileSource(bot.id, fileId),
        check: (fileId) => controller.source.call('botFileMeta', { params: { id: bot.id, fileId } }),
      },
    }),
    [bot, online, focusComposer, inbox, controller, active?.id]
  )

  useEffect(() => {
    void controller.openBot(bot.id)
    return () => controller.closeBot()
  }, [controller, bot.id])

  return (
    <ConversationContext.Provider value={context}>
      <Transcript bot={bot} />
      {isComposerLocked(bot) ? <LockedNotice bot={bot} /> : <Composer key={bot.id} bot={bot} inputRef={input} />}
    </ConversationContext.Provider>
  )
}

function HomeScreen() {
  const insets = useSafeAreaInsets()
  const { t } = useI18n()
  const { active, current, setCurrent } = useServers()
  const [open, setOpen] = useState(!current)
  const hosted = useChats(useCallback((state: ChatsState) => state.hosted, []))
  const waitingBots = useFleet(
    useCallback((state: FleetState) => new Set(state.inbox.map((item) => item.botId)).size, [])
  )
  const waitingChatCount = useChats(
    useCallback((state: ChatsState) => (state.hosted ? waitingChats(state.lists).length : 0), [])
  )
  const bot = useFleet(
    useCallback(
      (state: FleetState) =>
        current?.kind === 'bot' ? (state.bots.find((item) => item.id === current.id) ?? null) : null,
      [current]
    )
  )
  const chat = useChats(
    useCallback(
      (state: ChatsState) =>
        current?.kind === 'chat'
          ? (state.views[current.id]?.conversation ??
            allConversations(state.lists).find((item) => item.id === current.id) ??
            null)
          : null,
      [current]
    )
  )
  const runtime = useChats(
    useCallback(
      (state: ChatsState) => (current?.kind === 'chat' ? (state.views[current.id]?.runtime ?? null) : null),
      [current]
    )
  )
  const newWorkspace = useChats(
    useCallback(
      (state: ChatsState) =>
        current?.kind === 'new' && current.workspaceId
          ? (state.lists?.workspaces.find((item) => item.id === current.workspaceId) ?? null)
          : null,
      [current]
    )
  )
  const go = useCallback(
    (target: Current) => {
      setCurrent(target)
      setOpen(false)
    },
    [setCurrent]
  )
  // A chat in a workspace starts its next chat there; anything else starts a chat with no workspace.
  const newChat = hosted
    ? () =>
        go({
          kind: 'new',
          workspaceId:
            current?.kind === 'chat'
              ? (chat?.workspaceId ?? null)
              : current?.kind === 'new'
                ? current.workspaceId
                : null,
        })
    : null

  let title = null
  let body = <EmptyState chats={hosted} />
  if (current?.kind === 'bot' && bot) {
    title = <BotTitle bot={bot} />
    body = <BotConversation key={bot.id} bot={bot} />
  } else if (current?.kind === 'chat') {
    title = chat ? <ChatTitle chat={chat} runtime={runtime} serverName={active?.name ?? ''} /> : null
    body = <ChatConversation key={current.id} conversationId={current.id} />
  } else if (current?.kind === 'new' && hosted) {
    title = (
      <NewChatTitle
        where={newWorkspace ? t('chat.new.inWorkspace', { name: newWorkspace.name }) : t('chat.new.noWorkspace')}
      />
    )
    body = <NewChat key={current.workspaceId ?? ''} workspaceId={current.workspaceId} />
  }

  return (
    <Drawer open={open} onOpenChange={setOpen} panel={<DrawerPanel open={open} current={current} onOpen={go} />}>
      <KeyboardAvoidingView
        // Android draws the app edge to edge, so its window no longer shrinks for the keyboard either.
        behavior="padding"
        style={{ flex: 1, paddingTop: insets.top }}
      >
        <ConversationHeader
          title={title}
          waiting={waitingBots + waitingChatCount}
          onOpenMenu={() => setOpen(true)}
          onNewChat={newChat}
        />
        <ConnectionBanner />
        {body}
      </KeyboardAvoidingView>
    </Drawer>
  )
}

export default function Home() {
  const { palette } = useTheme()
  const { servers, controller, chats } = useServers()
  if (servers.length === 0) return <Redirect href="/welcome" />
  if (!controller || !chats) return <View style={{ flex: 1, backgroundColor: palette.canvas }} />
  return <HomeScreen />
}
