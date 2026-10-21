import { FLEET_MESSAGE_EDIT_FEATURE, type FleetBot, type FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { Redirect, router } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, type TextInputInstance, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChats } from '../chats/react'
import { waitingChats } from '../chats/selectors'
import { allConversations, type ChatsState } from '../chats/state'
import { DEMO_SERVER } from '../demo/demo-source'
import { lanesSupported, threadState, unseenRuns, unseenThreads } from '../fleet/lanes'
import { useFleet, useFleetController } from '../fleet/react'
import { isComposerLocked } from '../fleet/selectors'
import type { FleetState } from '../fleet/state'
import { editableItemId } from '../fleet/transcript-search'
import { GatewayError } from '../gateway/client'
import { useI18n } from '../i18n'
import { useServers, type Current } from '../servers/ServersProvider'
import { useTheme } from '../theme/ThemeProvider'
import { ChatConversation } from '../ui/chat/ChatConversation'
import { NewChat } from '../ui/chat/NewChat'
import { Composer } from '../ui/composer/Composer'
import { LockedNotice } from '../ui/composer/LockedNotice'
import { ConnectionBanner } from '../ui/ConnectionBanner'
import { botFileAccess } from '../ui/conversation/bot-file-fetch'
import { BotTitle, ChatTitle, ConversationHeader, NewChatTitle } from '../ui/conversation/ConversationHeader'
import { ConversationContext, type ConversationContextValue, type LanesAccess } from '../ui/conversation/CueCard'
import { ConversationSearchContext, useConversationSearch } from '../ui/conversation/ConversationSearch'
import { fileRevealKey, useFileReveal } from '../ui/conversation/file-reveal'
import { Transcript } from '../ui/conversation/Transcript'
import { FilesFullBanner } from '../ui/files/FilesFullBanner'
import { useBotFiles } from '../ui/files/use-bot-files'
import { Drawer } from '../ui/drawer/Drawer'
import { DrawerPanel } from '../ui/drawer/DrawerPanel'
import { Icon } from '../ui/icons'
import { citationKey, setCitation, useCitation } from '../ui/lanes/citations'
import { LaneBar, type LanePane } from '../ui/lanes/LaneBar'
import { openLaneScreen } from '../ui/lanes/LaneView'
import { RunsPane } from '../ui/lanes/RunsPane'
import { ThreadsPane } from '../ui/lanes/ThreadsPane'
import { AppText } from '../ui/primitives/Text'

const selectOnline = (state: FleetState) => state.connection === 'open'
const selectEditFeature = (state: FleetState) => state.features.includes(FLEET_MESSAGE_EDIT_FEATURE)
const selectFeatures = (state: FleetState) => state.features
const selectSeen = (state: FleetState) => state.seen

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
  const input = useRef<TextInputInstance>(null)
  const focusComposer = useCallback(() => input.current?.focus(), [])
  const { t } = useI18n()
  const serverEdits = useFleet(selectEditFeature)
  const items = useFleet(useCallback((state: FleetState) => state.transcripts[bot.id]?.items ?? null, [bot.id]))
  const queued = useFleet(
    useCallback((state: FleetState) => state.outbox.some((entry) => entry.botId === bot.id), [bot.id])
  )
  // As on a computer: the owner's last message, while the bot is idle with nothing waiting to be sent.
  const editableId =
    serverEdits && bot.capabilities.includes(FLEET_MESSAGE_EDIT_FEATURE) && bot.status === 'idle' && !queued
      ? editableItemId(items ?? [], 'bot')
      : null
  const [editing, setEditing] = useState<{ itemId: string; text: string } | null>(null)
  const startEdit = useCallback((itemId: string, text: string) => setEditing({ itemId, text }), [])
  const edit = useMemo(
    () => (editableId ? { itemId: editableId, start: startEdit } : undefined),
    [editableId, startEdit]
  )
  // --- Its side conversations: routine runs and conversations with other bots, each in a tab of its own. ---
  const features = useFleet(selectFeatures)
  const { runs: runsApart, threads: threadsApart } = lanesSupported(features, bot)
  const [pane, setPane] = useState<LanePane>('conversation')
  const search = useConversationSearch()
  const citeKey = citationKey(controller.source.serverId, bot.id)
  const citation = useCitation(citeKey)
  const openLane = useCallback(
    (kind: 'run' | 'thread', laneId: string) => openLaneScreen(bot.id, { kind, id: laneId }),
    [bot.id]
  )
  const lanes = useMemo<LanesAccess | undefined>(
    () =>
      runsApart || threadsApart
        ? {
            runs: runsApart,
            threads: threadsApart,
            openRun: (runId) => openLane('run', runId),
            openThread: (threadId) => openLane('thread', threadId),
            cite: (run) => setCitation(citeKey, run),
          }
        : undefined,
    [runsApart, threadsApart, openLane, citeKey]
  )
  // Its runs and threads are read once its conversation opens: its tabs count what is new, its notices need them.
  useEffect(() => {
    if (runsApart) controller.ensureRuns(bot.id)
    if (threadsApart) controller.ensureThreads(bot.id)
  }, [controller, bot.id, runsApart, threadsApart])
  const runs = useFleet(useCallback((state: FleetState) => state.runs[bot.id]?.runs ?? null, [bot.id]))
  const threads = useFleet(useCallback((state: FleetState) => state.threads[bot.id]?.threads ?? null, [bot.id]))
  const seen = useFleet(selectSeen)
  const counts = useMemo(() => {
    const seenRuns = seen.runs[bot.id]
    const seenThreads = seen.threads[bot.id]
    const fresh = threads && seenThreads ? unseenThreads(threads, new Map(Object.entries(seenThreads))) : []
    return {
      runs: runs && seenRuns ? unseenRuns(runs, new Set(seenRuns), bot).length : 0,
      threads: fresh.length,
      waiting: fresh.filter((thread) => threadState(thread, bot) === 'paused').length,
    }
  }, [bot, runs, threads, seen])
  // A citation chosen in a run's conversation brings the composer it goes to.
  useEffect(() => {
    if (citation) setPane('conversation')
  }, [citation])
  // Search looks through the bot's own conversation, which it brings back.
  useEffect(() => {
    if (search.open) setPane('conversation')
  }, [search.open])
  // Its files, so a full space shows above the message field and its cards know which files it deleted.
  const files = useBotFiles(bot)
  // So does a file its Files sheet shows there.
  const reveal = useFileReveal(fileRevealKey(controller.source.serverId, bot.id))
  useEffect(() => {
    if (reveal) setPane('conversation')
  }, [reveal])
  const choosePane = (next: LanePane) => {
    if (next !== 'conversation') search.setOpen(false)
    setPane(next)
  }

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
      sendMessage: async (text: string) => {
        await controller.send(bot.id, text, [])
      },
      files: botFileAccess(controller, bot.id, active?.id === DEMO_SERVER.id),
      ...(edit ? { edit } : {}),
      ...(lanes ? { lanes } : {}),
    }),
    [bot, online, focusComposer, inbox, controller, active?.id, edit, lanes]
  )

  useEffect(() => {
    void controller.openBot(bot.id)
    return () => controller.closeBot()
  }, [controller, bot.id])

  return (
    <ConversationContext.Provider value={context}>
      {lanes ? (
        <LaneBar
          bot={bot}
          pane={pane}
          onPane={choosePane}
          runs={runsApart}
          threads={threadsApart}
          newRuns={counts.runs}
          newThreads={counts.threads}
          waitingThreads={counts.waiting}
          onOpenTurn={(turn) => openLane(turn.kind === 'routine' ? 'run' : 'thread', turn.id)}
        />
      ) : null}
      {pane === 'runs' && runsApart ? (
        <RunsPane bot={bot} onOpen={(run) => openLane('run', run.id)} />
      ) : pane === 'threads' && threadsApart ? (
        <ThreadsPane bot={bot} onOpen={(thread) => openLane('thread', thread.id)} />
      ) : (
        <>
          <Transcript bot={bot} />
          {files.supported ? <FilesFullBanner bot={bot} usage={files.usage} /> : null}
          {isComposerLocked(bot) ? (
            <LockedNotice bot={bot} />
          ) : (
            <Composer
              key={bot.id}
              bot={bot}
              inputRef={input}
              citation={
                citation && runsApart
                  ? {
                      run: citation,
                      onOpen: () => openLane('run', citation.id),
                      onClear: () => setCitation(citeKey, null),
                    }
                  : null
              }
              editing={editing}
              onCancelEdit={() => setEditing(null)}
              onEdit={async (text) => {
                if (!editing) return
                try {
                  await controller.edit(bot.id, editing.itemId, text)
                } catch (cause) {
                  throw new Error(
                    cause instanceof GatewayError && cause.code === 'PROTOCOL_INCOMPATIBLE'
                      ? t('edit.error.outdated')
                      : cause instanceof GatewayError && cause.status === 409
                        ? t('edit.error.busy')
                        : t('edit.error.failed')
                  )
                }
                setEditing(null)
              }}
            />
          )}
        </>
      )}
    </ConversationContext.Provider>
  )
}

function HomeScreen() {
  const insets = useSafeAreaInsets()
  const { t } = useI18n()
  const { active, current, setCurrent } = useServers()
  const [open, setOpen] = useState(!current)
  const [searching, setSearching] = useState(false)
  const search = useMemo(() => ({ open: searching, setOpen: setSearching }), [searching])
  const currentKey = current ? `${current.kind}:${current.kind === 'new' ? current.workspaceId : current.id}` : ''
  // Each conversation opens without a search.
  useEffect(() => setSearching(false), [currentKey])
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
  // The new bot opens here once created, so the menu closes under the sheet.
  const newBot = useCallback((environmentId: string | null) => {
    setOpen(false)
    router.push({ pathname: '/new-bot', params: environmentId ? { environment: environmentId } : {} })
  }, [])
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
    <Drawer
      open={open}
      onOpenChange={setOpen}
      panel={<DrawerPanel open={open} current={current} onOpen={go} onNewBot={newBot} />}
    >
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
          onSearch={
            (current?.kind === 'bot' && bot) || current?.kind === 'chat' ? () => setSearching((value) => !value) : null
          }
        />
        <ConnectionBanner />
        <ConversationSearchContext.Provider value={search}>{body}</ConversationSearchContext.Provider>
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
