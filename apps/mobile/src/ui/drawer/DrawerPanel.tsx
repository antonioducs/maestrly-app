import { router } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useChats, useChatsController } from '../../chats/react'
import { isWaitingChat, searchChats, waitingChats, workspaceGroups, workspaceResultCount } from '../../chats/selectors'
import type { ChatsState } from '../../chats/state'
import { useFleet } from '../../fleet/react'
import { botsByEnvironment, waitingItems } from '../../fleet/selectors'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useServers, type Current } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts, mix } from '../../theme/tokens'
import { BotAvatar } from '../Avatar'
import { ChatHostBanner } from '../chat/ChatHostBanner'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { BotList } from './BotList'
import { ChatList } from './ChatList'
import { ServerRow } from './ServerRow'
import { TabBar } from './TabBar'
import { WaitingStrip, type WaitingEntry } from './WaitingStrip'
import { WorkspaceList, WorkspacePage } from './WorkspaceList'

type TabId = 'chats' | 'workspaces' | 'bots'

const selectState = (state: FleetState) => state
const selectOnline = (state: FleetState) => state.connection === 'open'
const selectChats = (state: ChatsState) => state

/** The tab that holds a conversation, so the open menu shows where you are. */
function tabOf(current: Current | null, hosted: boolean): TabId {
  if (!hosted || current?.kind === 'bot') return 'bots'
  if (current?.kind === 'new') return current.workspaceId ? 'workspaces' : 'chats'
  return 'chats'
}

function ChatGlyph({ workspace }: { workspace: boolean }) {
  const { palette } = useTheme()
  return (
    <View
      style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        backgroundColor: palette.raised,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={workspace ? 'folder' : 'message'} size={15} color={palette.ink} />
    </View>
  )
}

/** The menu: search, the server, what waits on you, and the chats, workspaces and bots of the server. */
export function DrawerPanel({
  open,
  current,
  onOpen,
}: {
  open: boolean
  current: Current | null
  onOpen: (target: Current) => void
}) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const insets = useSafeAreaInsets()
  const { active } = useServers()
  const chats = useChatsController()
  const [query, setQuery] = useState('')
  const fleet = useFleet(selectState)
  const online = useFleet(selectOnline)
  const chatState = useChats(selectChats)
  const hosted = chatState.hosted
  const [tab, setTab] = useState<TabId>(() => tabOf(current, hosted))
  const [workspacePage, setWorkspacePage] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const scroll = useRef<ScrollView>(null)
  const groupY = useRef(new Map<string, number>())
  const botY = useRef(new Map<string, { groupId: string; y: number }>())
  // The drawer well sits on the drawer itself: in light mode the surface color is nearly the drawer's.
  const well = mix(palette.ink, palette.drawer, 0.07)
  const q = query.trim()

  // Opening the menu shows the tab of what is open, and reads the lists again: renames elsewhere are not announced.
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    chats.refreshLists()
    if (current?.kind === 'chat') {
      const chat = chatState.lists?.chats.find((item) => item.id === current.id)
      setTab(chat ? 'chats' : hosted ? 'workspaces' : 'bots')
    } else setTab(tabOf(current, hosted))
  }, [open])
  useEffect(() => {
    if (!hosted && tab !== 'bots') setTab('bots')
  }, [hosted, tab])
  // Chats are learned of after the bots: with nothing open yet, the menu then starts on them.
  useEffect(() => {
    if (hosted && !current) setTab('chats')
  }, [hosted])
  // The open bot shows without scrolling to it.
  useEffect(() => {
    if (!open || tab !== 'bots' || current?.kind !== 'bot') return
    const row = botY.current.get(current.id)
    if (!row) return
    scroll.current?.scrollTo({ y: Math.max(0, (groupY.current.get(row.groupId) ?? 0) + row.y - 60), animated: false })
  }, [open, tab])

  const currentChatId = current?.kind === 'chat' ? current.id : null
  const currentBotId = current?.kind === 'bot' ? current.id : null
  const groups = botsByEnvironment(fleet, q, t('drawer.bots'))
  const chatResults = useMemo(() => searchChats(chatState.lists, q), [chatState.lists, q])
  const workspaceResults = useMemo(() => workspaceGroups(chatState.lists, q), [chatState.lists, q])
  const counts: Record<TabId, number> = {
    chats: chatResults.length,
    workspaces: workspaceResultCount(workspaceResults),
    bots: groups.reduce((sum, group) => sum + group.bots.length, 0),
  }

  const waitingBots = waitingItems(fleet)
  const waitingList = hosted ? waitingChats(chatState.lists) : []
  const waiting: WaitingEntry[] = [
    ...waitingBots.map(({ bot, interaction }) => ({
      key: `bot:${bot.id}`,
      title: bot.name,
      what: t(`wait.${interaction.kind}`),
      lead: <BotAvatar bot={bot} size={30} />,
      onPress: () => onOpen({ kind: 'bot', id: bot.id }),
    })),
    ...waitingList.map((chat) => ({
      key: `chat:${chat.id}`,
      title: chat.name,
      what: t(chat.status === 'asking' ? 'wait.question' : 'wait.permission'),
      lead: <ChatGlyph workspace={chat.workspaceId !== null} />,
      onPress: () => onOpen({ kind: 'chat', id: chat.id }),
    })),
  ]
  const badges: Record<TabId, number> = {
    chats: (chatState.lists?.chats ?? []).filter(isWaitingChat).length,
    workspaces: (chatState.lists?.workspaces ?? [])
      .flatMap((workspace) => workspace.conversations)
      .filter(isWaitingChat).length,
    bots: waitingBots.length,
  }
  const labels: Record<TabId, string> = {
    chats: t('drawer.chats'),
    workspaces: t('drawer.workspaces'),
    bots: t('drawer.bots'),
  }
  const tabs: TabId[] = hosted ? ['chats', 'workspaces', 'bots'] : ['bots']

  const openChat = useCallback((id: string) => onOpen({ kind: 'chat', id }), [onOpen])
  const newChat = useCallback((workspaceId: string | null) => onOpen({ kind: 'new', workspaceId }), [onOpen])
  const choose = (id: TabId) => {
    setTab(id)
    setWorkspacePage(null)
    scroll.current?.scrollTo({ y: 0, animated: false })
  }

  // A search shows this tab's results and how many the other tabs have, as the desktop sidebar does.
  const cross = q
    ? tabs
        .filter((id) => id !== tab && counts[id] > 0)
        .map((id) => (
          <Pressable
            key={id}
            accessibilityRole="button"
            onPress={() => choose(id)}
            style={({ pressed }) => ({
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 10,
              borderRadius: 12,
              backgroundColor: pressed ? palette.surface : 'transparent',
            })}
          >
            <AppText variant="sub" style={{ color: palette.cueInk, fontWeight: '600' }}>
              {plural('drawer.crossResults', counts[id], { tab: labels[id] })}
            </AppText>
            <Icon name="chev-right" size={14} color={palette.cueInk} />
          </Pressable>
        ))
    : null
  const muted = (text: string) => (
    <AppText variant="sub" tone="muted" style={{ paddingHorizontal: 10, paddingVertical: 14, fontSize: 13.5 }}>
      {text}
    </AppText>
  )

  let list: ReactNode
  if (tab === 'bots') {
    list = groups.length ? (
      <BotList
        groups={groups}
        currentBotId={currentBotId}
        onOpen={(id) => onOpen({ kind: 'bot', id })}
        onGroupLayout={(id, y) => groupY.current.set(id, y)}
        onBotLayout={(id, groupId, y) => botY.current.set(id, { groupId, y })}
      />
    ) : q ? (
      muted(
        cross?.length ? t('drawer.noMatchIn', { tab: labels.bots, query: q }) : t('drawer.nothingMatches', { query: q })
      )
    ) : (
      muted(fleet.loaded ? t('drawer.noBots') : t('common.loading'))
    )
  } else if (!chatState.lists) {
    list = (
      <View style={{ paddingTop: 6 }}>
        {chatState.bridge === 'connecting' || chatState.bridge === 'closed' ? muted(t('common.loading')) : null}
      </View>
    )
  } else if (tab === 'chats') {
    list = chatResults.length ? (
      <ChatList chats={chatResults} currentId={currentChatId} now={now} onOpen={openChat} />
    ) : q ? (
      muted(
        cross?.length
          ? t('drawer.noMatchIn', { tab: labels.chats, query: q })
          : t('drawer.nothingMatches', { query: q })
      )
    ) : (
      <View style={{ paddingHorizontal: 10, paddingVertical: 14, gap: 12, alignItems: 'flex-start' }}>
        <AppText variant="sub" tone="muted" style={{ fontSize: 13.5, lineHeight: 19 }}>
          {t('drawer.noChats')}
        </AppText>
        <Button
          label={t('drawer.newChat')}
          icon="compose"
          variant="secondary"
          size="sm"
          onPress={() => newChat(null)}
        />
      </View>
    )
  } else {
    const page = workspacePage
      ? workspaceGroups(chatState.lists, q).find((group) => group.workspace.id === workspacePage)
      : null
    list = page ? (
      <WorkspacePage
        group={page}
        query={q}
        currentId={currentChatId}
        now={now}
        onBack={() => setWorkspacePage(null)}
        onOpen={openChat}
        onNew={() => newChat(page.workspace.id)}
      />
    ) : workspaceResults.length ? (
      <WorkspaceList
        groups={workspaceResults}
        searching={q !== ''}
        currentId={currentChatId}
        onOpen={openChat}
        onNew={(id) => newChat(id)}
        onShowAll={setWorkspacePage}
      />
    ) : q ? (
      muted(
        cross?.length
          ? t('drawer.noMatchIn', { tab: labels.workspaces, query: q })
          : t('drawer.nothingMatches', { query: q })
      )
    ) : (
      muted(t('drawer.noWorkspaces'))
    )
  }

  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <View style={{ paddingTop: 6, paddingBottom: 4, paddingLeft: 14, paddingRight: 14 }}>
        <View
          style={{
            height: 40,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 12,
            borderRadius: 12,
            backgroundColor: well,
          }}
        >
          <Icon name="search" size={18} color={palette.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={hosted ? t('drawer.searchAll') : t('drawer.search')}
            placeholderTextColor={palette.faint}
            accessibilityLabel={hosted ? t('drawer.searchAll') : t('drawer.search')}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={{ flex: 1, minWidth: 0, height: 40, color: palette.ink, fontFamily: fonts.body, fontSize: 16 }}
          />
        </View>
      </View>
      {active ? <ServerRow name={active.name} online={online} onPress={() => router.push('/servers')} /> : null}
      {q ? null : <WaitingStrip items={waiting} />}
      <TabBar
        tabs={tabs.map((id) => ({
          id,
          label: labels[id],
          badge: badges[id] || undefined,
          badgeLabel: t('drawer.waitingCount', { count: badges[id] }),
        }))}
        value={tab}
        onChange={(id) => choose(id as TabId)}
      />
      {tab !== 'bots' ? (
        <View style={{ marginTop: 8 }}>
          <ChatHostBanner quiet />
        </View>
      ) : null}
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}
        keyboardShouldPersistTaps="handled"
      >
        {list}
        {cross}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('drawer.settings')}
        onPress={() => router.push('/settings')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          marginHorizontal: 8,
          paddingTop: 12,
          paddingHorizontal: 10,
          paddingBottom: insets.bottom + 10,
          borderTopWidth: 1,
          borderTopColor: palette.line,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon name="settings" size={20} color={palette.ink} />
        <AppText variant="bodyMedium">{t('drawer.settings')}</AppText>
      </Pressable>
    </View>
  )
}
