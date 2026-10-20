import { PersonalMemoryView } from '@/components/PersonalMemoryView'
import { requestMainNavigation } from '@/lib/main-navigation'
/** Local desktop shell. Keep live conversations mounted while project panels replace the main view.
 * Native drawer and popup surfaces are suppressed whenever a DOM overlay needs to cover them. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelRight, MessagesSquare } from 'lucide-react'
import { i18n } from '@/lib/i18n'
import { setComposerPrefill } from '@/lib/composer-prefill'
import type { Conversation, Workspace, FloatTab } from '../preload'
import { cn } from '@/lib/utils'
import { Sidebar, type SidebarHostSection } from '@/components/Sidebar'
import { ChatView } from '@/components/chat/ChatView'
import { ChatWindowButton, ChatWindowHost } from '@/components/chat/ChatWindowHost'
import { useDetachedChatKeys } from '@/lib/chat-windows'
import { ConversationBranchChip } from '@/components/ConversationBranchChip'
import { BotConversationBadge, BotManagementControls } from '@/components/bot/BotConversationBadge'
import { NewConversationDialog } from '@/components/NewConversationDialog'
import { WorkspaceDefaultBranchDialog } from '@/components/WorkspaceDefaultBranchDialog'
import { Drawer } from '@/components/Drawer'
import { sanitizeMainOrder } from '@/lib/drawer-tabs'
import { ProjectNotesView } from '@/components/ProjectNotesView'
import { ProjectMemoryView } from '@/components/ProjectMemoryView'
import { PopupOverlay } from '@/components/PopupOverlay'
import { Button } from '@/components/ui/button'
import { SettingsProvider } from '@/lib/use-settings'
import { OnboardingProvider } from '@/lib/use-onboarding'
import { UpdateProvider } from '@/lib/use-update'
import { SettingsView } from '@/components/SettingsView'
import { ArtifactsCenter } from '@/components/artifacts/ArtifactsCenter'
import { OnboardingFlow } from '@/components/OnboardingFlow'
import { AboutModal } from '@/components/AboutModal'
import { useDrawerState } from '@/lib/use-drawer-state'
import { useWorkspaces } from '@/lib/use-workspaces'
import { useMainPanels, type FleetView } from '@/lib/use-main-panels'
import { useFleets, type FleetServers } from '@/lib/fleet/use-fleet'
import { FleetServerProvider } from '@/lib/fleet/server-context'
import { defaultFleetServer, type FleetServerId, NO_FLEET_SERVER } from '../shared/fleet-servers'
import { useBotUpdates } from '@/lib/fleet/use-bot-updates'
import { PersistentBotViews } from '@/components/fleet/PersistentBotViews'
import { EnvironmentView } from '@/components/fleet/EnvironmentView'
import { ServerView } from '@/components/fleet/ServerView'
import { InboxView } from '@/components/fleet/InboxView'
import { OwnerMemoryView } from '@/components/fleet/OwnerMemoryView'
import { CreateBotDialog } from '@/components/fleet/CreateBotDialog'
import { useAgentStatuses } from '@/lib/use-agent-statuses'
import { usePlans } from '@/lib/use-plans'
import { ProjectSetupDialog } from '@/project-setup/ProjectSetupDialog'
import { useProjectSetup, type ProjectSetupOptions } from '@/project-setup/use-project-setup'
import { useConversationMigration } from '@/lib/use-conversation-migration'
import { ConversationMigrationDialog } from '@/components/conversation-migration/ConversationMigrationDialog'
import { MigrationRecoveryGate } from '@/components/conversation-migration/MigrationRecoveryGate'
import { useConversationMove } from '@/lib/use-conversation-move'
import { moveTargetsFor } from '@/lib/conversation-move/flow'
import { ConversationMoveDialog } from '@/components/conversation-move/ConversationMoveDialog'
import { ConversationMoveRecoveryGate } from '@/components/conversation-move/ConversationMoveRecoveryGate'
import { hostName } from '@/components/sidebar/HostSection'
import { CHAT_VIEW_COLD_TTL_MS, pruneMountedChatViews } from '@/lib/conversation-mount-lru'
import { useMemoryAutoReclaim } from '@/lib/use-memory-auto-reclaim'
import { hostApi, HostProvider } from '@/lib/hosts/host-context'
import { ReviewHeaderButton } from '@/components/chat/review/ReviewHeaderButton'
import { useHosts } from '@/lib/hosts/use-hosts'
import { type RemoteHostShell, RemoteHostRuntime, remoteConversationLabels } from '@/lib/hosts/remote-host-runtime'
import {
  hostConversation,
  hostOfKey,
  hostTarget,
  hostWorkspace,
  isRemoteKey,
  rawId,
  shellConversation,
} from '@/lib/hosts/shell-keys'
import { HostUnavailableOverlay } from '@/components/HostUnavailableOverlay'
import { type HostId, hostKey, LOCAL_HOST_ID } from '../shared/host-key'
import type { HostView } from '../shared/hosts'

export function DesktopApp() {
  const fleets = useFleets()
  // The Bots tab shows one server: the one chosen while it is paired, else the default one.
  const [chosenServer, setChosenServer] = useState<FleetServerId | null>(null)
  const botsServer =
    chosenServer && fleets.servers.some((server) => server.id === chosenServer)
      ? chosenServer
      : (defaultFleetServer(fleets.servers)?.id ?? NO_FLEET_SERVER)
  return (
    <FleetServerProvider serverId={botsServer}>
      <DesktopShell fleets={fleets} botsServer={botsServer} onBotsServer={setChosenServer} />
    </FleetServerProvider>
  )
}

function DesktopShell({
  fleets,
  botsServer,
  onBotsServer,
}: {
  fleets: FleetServers
  botsServer: FleetServerId
  onBotsServer: (serverId: FleetServerId) => void
}) {
  const api = hostApi(LOCAL_HOST_ID)
  const { t } = useTranslation('ui')
  const [active, setActive] = useState<Conversation | null>(null)
  const mainRef = useRef<HTMLElement>(null)

  const [mountedConvs, setMountedConvs] = useState<Conversation[]>([])
  const detachedChatKeys = useDetachedChatKeys()
  const [unsafeChatIds, setUnsafeChatIds] = useState<ReadonlySet<string>>(new Set())
  const lastVisibleAtRef = useRef<Record<string, number>>({})
  const [hardPressure, setHardPressure] = useState(false)
  const autoReclaimEnabled = useMemoryAutoReclaim()
  const drawer = useDrawerState({ active, mainRef, setMountedConvs })
  const {
    drawerOpen,
    setDrawerOpen,
    drawerTab,
    setDrawerTabByConv,
    setActiveDrawerTab,
    openTabs,
    setOpenTabsByConv,
    openDrawerTab,
    closeDrawerTab,
    reorderOpenTabs,
    hydrateOpenTabs,
    setDrawerOpenByConv,
    setMainTabOrderByConv,
    setDrawerWidthByConv,
    setDrawerFullByConv,
    mainTabOrder,
    forgetConvDrawerState,
    drawerWidth,
    toggleDrawerFull,
    fullActive,
    dragging,
    chatGptWebEnabled,
    drawerShortcutLabel,
  } = drawer
  // A conversation of the window carries its host in its id (see lib/hosts/shell-keys). What this computer's own
  // hooks and dialogs take is its conversation only: a remote host's is handled by that host's runtime below.
  const activeRemote = active !== null && isRemoteKey(active.id)
  const activeLocal = activeRemote ? null : active
  const ws = useWorkspaces({ active: activeLocal, setActive, forgetConvDrawerState })
  const {
    workspaces,
    standaloneConversations,
    standaloneArchivedCount,
    handleReorderStandaloneConversations,
    groups,
    showArchived,
    setShowArchived,
    refreshWorkspaces,
    reconcileWorkspace,
    handleRemoveWorkspace,
    handleRename,
    handleArchive,
    handlePinConversation,
    handleDelete,
    handleArchiveSiblings,
    handleDeleteSiblings,
    handleReorderWorkspaces,
    handleReorderConversations,
    handleCreateGroup,
    handleRenameGroup,
    handleDeleteGroup,
    handleReorderGroups,
    handleToggleGroupCollapsed,
    handleMoveWorkspaceToGroup,
    handleToggleWorkspaceCollapsed,
  } = ws
  // Remote hosts: what each one lists arrives from its runtime (rendered below), already keyed for the window.
  const hosts = useHosts()
  const remoteHosts = useMemo(() => hosts.filter((host) => host.remote), [hosts])
  const hostViews = useMemo(() => new Map<HostId, HostView>(hosts.map((host) => [host.id, host])), [hosts])
  const [remote, setRemote] = useState<Record<HostId, RemoteHostShell>>({})
  // This app's version, to say which of the two to update when a host runs another one.
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    if (remoteHosts.length === 0 || appVersion !== null) return
    void window.api
      .getAppInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => undefined)
  }, [remoteHosts.length, appVersion])
  const remoteRef = useRef(remote)
  remoteRef.current = remote
  const onRemoteChange = useCallback((shell: RemoteHostShell) => {
    setRemote((previous) => {
      const known = previous[shell.hostId]
      // A host that answers again lists from scratch: until it has, what it listed before stays on screen.
      const next = shell.loaded || !known?.loaded ? shell : { ...known, actions: shell.actions }
      return { ...previous, [shell.hostId]: next }
    })
  }, [])
  useEffect(() => {
    const present = new Set(remoteHosts.map((host) => host.id))
    setRemote((previous) =>
      Object.keys(previous).every((id) => present.has(id))
        ? previous
        : Object.fromEntries(Object.entries(previous).filter(([id]) => present.has(id)))
    )
    // A conversation of a host that left (its server was disconnected) is no longer shown.
    setActive((current) => (current && isRemoteKey(current.id) && !present.has(hostOfKey(current.id)) ? null : current))
  }, [remoteHosts])
  const remoteLists = useRef<{ sources: unknown[]; conversations: Conversation[] }>({ sources: [], conversations: [] })
  const remoteConversations = useMemo(() => {
    // Statuses of a remote host change far more often than its lists: the list of conversations keeps its identity.
    const shells = Object.values(remote)
    const sources = shells.flatMap((shell) => [shell.standaloneConversations, shell.workspaces])
    const cached = remoteLists.current
    if (sources.length === cached.sources.length && sources.every((item, index) => item === cached.sources[index]))
      return cached.conversations
    const conversations: Conversation[] = shells.flatMap((shell) => [
      ...shell.standaloneConversations,
      ...shell.workspaces.flatMap((workspace) => workspace.conversations),
    ])
    remoteLists.current = { sources, conversations }
    return conversations
  }, [remote])
  // The remote conversations the window listed last, whose windows and views close once they leave the lists.
  const remoteListedRef = useRef(new Set<string>())
  // Floating windows of a remote host's conversation are named after it; the lists change only as the hosts list again.
  useEffect(() => {
    window.api.drawerSetRemoteConversations(remoteConversationLabels(Object.values(remoteRef.current)))
  }, [remoteConversations])
  const handleConversationExperienceChange = useCallback(
    (conversationId: string, experience: Conversation['experience']) => {
      setActive((current) =>
        current?.id === conversationId && current.scope !== 'standalone' ? { ...current, experience } : current
      )
      setMountedConvs((current) =>
        current.map((conversation) =>
          conversation.id === conversationId && conversation.scope !== 'standalone'
            ? { ...conversation, experience }
            : conversation
        )
      )
      if (isRemoteKey(conversationId)) void remoteRef.current[hostOfKey(conversationId)]?.actions.refresh()
      else void refreshWorkspaces()
    },
    [refreshWorkspaces]
  )
  const allConversations = useMemo(
    () => [
      ...standaloneConversations,
      ...workspaces.flatMap((workspace) => workspace.conversations),
      ...remoteConversations,
    ],
    [workspaces, standaloneConversations, remoteConversations]
  )
  useEffect(() => {
    setActive((current) => {
      if (current?.scope !== 'standalone') return current
      const refreshed = standaloneConversations.find((conversation) => conversation.id === current.id)
      return refreshed && refreshed.name !== current.name ? { ...current, name: refreshed.name } : current
    })
  }, [standaloneConversations])
  const protectedChatIds = useMemo(() => {
    const ids = new Set<string>()
    for (const key of detachedChatKeys) {
      if (key.startsWith('conversation:')) ids.add(key.slice('conversation:'.length))
    }
    return ids
  }, [detachedChatKeys])

  // One project setup at a time, on the host it was asked for; its workspaces keep that host's own ids.
  const [projectHost, setProjectHost] = useState<HostId>(LOCAL_HOST_ID)
  const projectHostRef = useRef<HostId>(LOCAL_HOST_ID)
  const reconcileProjectWorkspace = useCallback(
    async (workspaceId: string) => {
      const host = projectHostRef.current
      if (host === LOCAL_HOST_ID) return reconcileWorkspace(workspaceId)
      const listed = await remoteRef.current[host]?.actions.reconcileWorkspace(hostKey(host, workspaceId))
      return listed ? hostWorkspace(listed) : null
    },
    [reconcileWorkspace]
  )
  const projectSetup = useProjectSetup(reconcileProjectWorkspace, projectHost)
  const [focusedWorkspaceId, setFocusedWorkspaceId] = useState<string | null>(null)
  // Projects a chat created or cloned appear in the sidebar without a manual refresh; the chat card can focus them.
  useEffect(() => api.onWorkspacesChanged(() => void refreshWorkspaces()), [api, refreshWorkspaces])
  useEffect(() => {
    const focus = (event: Event) => {
      // A shell key: the card may sit in a conversation of a workspaces host, which lists its own workspaces.
      const workspaceKey = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId
      if (!workspaceKey) return
      const host = hostOfKey(workspaceKey)
      const listed =
        host === LOCAL_HOST_ID ? refreshWorkspaces() : (remoteRef.current[host]?.actions.refresh() ?? Promise.resolve())
      void listed.then(() => {
        setFocusedWorkspaceId(null)
        requestAnimationFrame(() => setFocusedWorkspaceId(workspaceKey))
      })
    }
    window.addEventListener('maestrly:focus-workspace', focus)
    return () => window.removeEventListener('maestrly:focus-workspace', focus)
  }, [refreshWorkspaces])
  const requestProjectOn = useCallback(
    async (hostId: HostId, options?: ProjectSetupOptions): Promise<Workspace | null> => {
      setFocusedWorkspaceId(null)
      projectHostRef.current = hostId
      setProjectHost(hostId)
      const workspace = await projectSetup.requestProject(options)
      if (workspace) setFocusedWorkspaceId(hostKey(hostId, workspace.id))
      return workspace
    },
    [projectSetup.requestProject]
  )
  const requestProject = useCallback(
    (options?: ProjectSetupOptions) => requestProjectOn(LOCAL_HOST_ID, options),
    [requestProjectOn]
  )
  // Links to a conversation or its memory find it among the conversations of every host, keyed for the window.
  const everyHostWorkspaces = useMemo(
    () => [...workspaces, ...Object.values(remote).flatMap((shell) => shell.workspaces)],
    [workspaces, remote]
  )
  const everyHostChats = useMemo(
    () => [...standaloneConversations, ...Object.values(remote).flatMap((shell) => shell.standaloneConversations)],
    [standaloneConversations, remote]
  )
  const refreshHostWorkspaces = useCallback(
    async (hostId: HostId) =>
      hostId === LOCAL_HOST_ID ? refreshWorkspaces() : ((await remoteRef.current[hostId]?.actions.refresh()) ?? []),
    [refreshWorkspaces]
  )
  const nav = useMainPanels({
    workspaces: everyHostWorkspaces,
    standaloneConversations: everyHostChats,
    setActive,
    refreshWorkspaces,
    refreshHostWorkspaces,
  })
  const fleet = fleets.controller(botsServer)
  const botUpdates = useBotUpdates(fleet)
  const [fleetTabRequest, setFleetTabRequest] = useState(0)
  const openFleetView = useCallback(
    (view: FleetView) => {
      nav.openFleetView(view)
      setFleetTabRequest((value) => value + 1)
    },
    [nav.openFleetView]
  )
  const openFleetBot = useCallback(
    (botId: string, screen = false) => {
      openFleetView({ kind: 'bot', botId, tab: screen ? 'screen' : 'conversation' })
    },
    [openFleetView]
  )
  const openFleetEnvironment = useCallback(
    (environmentId: string) => openFleetView({ kind: 'environment', environmentId, tab: 'overview' }),
    [openFleetView]
  )
  const {
    projectNotesWs,
    setProjectNotesWs,
    memoryTarget,
    showPersonalMemoryOf,
    focusMemoryId,
    focusMemoryRequest,
    setProjectMemoryWs,
    settingsOpen,
    setSettingsOpen,
    artifactsOpen,
    setArtifactsOpen,
    settingsSection,
    settingsRequest,
    onboardingOpen,
    setOnboardingOpen,
    onboardingChecked,
    mainOverride,
    fleetView,
    createBot,
    setCreateBot,
    createBotEnvironmentId,
    openCreateBot,
    openSettings,
    openOnboarding,
    handleSelect,
    handleCreated,
    completeOnboarding,
  } = nav

  const creatingChatRef = useRef(false)
  const [creatingChat, setCreatingChat] = useState(false)
  const handleNewChat = useCallback(async () => {
    if (creatingChatRef.current) return
    creatingChatRef.current = true
    setCreatingChat(true)
    try {
      const conversation = await api.createStandaloneConversation()
      await handleCreated(conversation)
      handleSelect(conversation)
    } catch (error) {
      alert(i18n.t('ui:app.createChatFailed', { error: String(error) }))
    } finally {
      creatingChatRef.current = false
      setCreatingChat(false)
    }
  }, [handleCreated, handleSelect, api])

  const [creatingRemoteChat, setCreatingRemoteChat] = useState<HostId | null>(null)
  const creatingRemoteChatRef = useRef(false)
  const handleNewRemoteChat = useCallback(
    async (hostId: HostId) => {
      const actions = remoteRef.current[hostId]?.actions
      if (!actions || creatingRemoteChatRef.current) return
      creatingRemoteChatRef.current = true
      setCreatingRemoteChat(hostId)
      try {
        handleSelect(await actions.newChat())
      } catch (error) {
        alert(i18n.t('ui:app.createChatFailed', { error: String(error) }))
      } finally {
        creatingRemoteChatRef.current = false
        setCreatingRemoteChat(null)
      }
    },
    [handleSelect]
  )
  const handleRemoteCreated = useCallback(
    async (hostId: HostId, conversation: Conversation) => {
      await remoteRef.current[hostId]?.actions.refresh()
      handleSelect(shellConversation(hostId, conversation))
    },
    [handleSelect]
  )

  // A new conversation for a given request, such as a suggestion in the Artifacts center: it opens with the request
  // in its composer, ready to edit and send, and with Maestrly tools on when the request needs them.
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: unknown; appTools?: unknown; settle?: () => void }>).detail
      const prompt = typeof detail?.prompt === 'string' ? detail.prompt.trim() : ''
      if (!prompt) return
      if (creatingChatRef.current) return detail.settle?.()
      creatingChatRef.current = true
      setCreatingChat(true)
      void (async () => {
        try {
          const conversation = await api.createStandaloneConversation()
          if (detail.appTools === true)
            await api.chatSetConvTools(conversation.id, { app: true }).catch(() => undefined)
          setComposerPrefill(conversation.id, prompt)
          await handleCreated(conversation)
          handleSelect(conversation)
        } catch (error) {
          alert(i18n.t('ui:app.createChatFailed', { error: String(error) }))
        } finally {
          creatingChatRef.current = false
          setCreatingChat(false)
          detail.settle?.()
        }
      })()
    }
    window.addEventListener('maestrly:new-chat-with-prompt', onRequest)
    return () => window.removeEventListener('maestrly:new-chat-with-prompt', onRequest)
  }, [handleCreated, handleSelect])

  const [chatGptFloating, setChatGptFloating] = useState(false)
  const [chatGptFloatingVisible, setChatGptFloatingVisible] = useState(false)
  useEffect(() => {
    const conversationId = active?.id ?? null
    setChatGptFloating(false)
    setChatGptFloatingVisible(false)
    if (!conversationId) return
    let alive = true
    const apply = (state: { convId: string; floating: string[]; visible?: string[] }) => {
      if (!alive || state.convId !== conversationId) return
      setChatGptFloating(state.floating.includes('chatgpt'))
      setChatGptFloatingVisible(state.visible?.includes('chatgpt') === true)
    }
    void window.api
      .getFloatingState(conversationId)
      .then(apply)
      .catch(() => undefined)
    const off = window.api.onFloatingState(apply)
    return () => {
      alive = false
      off()
    }
  }, [active?.id])

  const [visiblePopupTab, setVisiblePopupTab] = useState<FloatTab | null>(null)
  useEffect(() => {
    const conversationId = active?.id ?? null
    setVisiblePopupTab(null)
    if (!conversationId) return
    let alive = true
    const apply = (state: { convId: string | null; stack: Array<{ tab: FloatTab }>; suppressed: boolean }) => {
      if (!alive) return
      if (state.convId === null) {
        setVisiblePopupTab(null)
        return
      }
      if (state.convId !== conversationId) return
      setVisiblePopupTab(state.suppressed ? null : (state.stack[state.stack.length - 1]?.tab ?? null))
    }
    void window.api
      .getPopupState(conversationId)
      .then(apply)
      .catch(() => undefined)
    const off = window.api.onPopupState(apply)
    return () => {
      alive = false
      off()
    }
  }, [active?.id])
  const chatGptDrawerVisibleConversationId =
    active && drawerOpen && !mainOverride && !chatGptFloating && visiblePopupTab === null && drawerTab === 'chatgpt'
      ? active.id
      : null
  const chatGptPopupVisibleConversationId = active && visiblePopupTab === 'chatgpt' ? active.id : null
  const chatGptVisibleConversationId =
    chatGptPopupVisibleConversationId ??
    chatGptDrawerVisibleConversationId ??
    (chatGptFloatingVisible ? (active?.id ?? null) : null)
  const agents = useAgentStatuses({
    refreshWorkspaces,
    activeId: activeLocal?.id ?? null,
    mainOverride,
    chatGptVisibleConversationId,
  })
  const { acknowledgeConversation } = agents
  // What the window shows of every host together: this computer's, and each remote host's under its keys.
  const statuses = useMemo(
    () => Object.assign({}, agents.statuses, ...Object.values(remote).map((shell) => shell.statuses)),
    [agents.statuses, remote]
  ) as typeof agents.statuses
  const remoteAttention = useMemo(() => Object.values(remote).flatMap((shell) => [...shell.attention]), [remote])
  const attention = remoteAttention.length ? new Set([...agents.attention, ...remoteAttention]) : agents.attention
  const handleSidebarConversationSelect = useCallback(
    (conv: Conversation) => {
      if (isRemoteKey(conv.id)) remoteRef.current[hostOfKey(conv.id)]?.actions.acknowledgeConversation(conv.id)
      else acknowledgeConversation(conv.id)
      handleSelect(conv)
    },
    [acknowledgeConversation, handleSelect]
  )
  const onChatEvictionSafetyChange = useCallback((conversationId: string, safeToEvict: boolean) => {
    setUnsafeChatIds((previous) => {
      const isUnsafe = previous.has(conversationId)
      if (isUnsafe === !safeToEvict) return previous
      const next = new Set(previous)
      if (safeToEvict) next.delete(conversationId)
      else next.add(conversationId)
      return next
    })
  }, [])
  const plan = usePlans({ openDrawerTab, setDrawerOpenByConv })
  const plans = useMemo(
    () => Object.assign({}, plan.plans, ...Object.values(remote).map((shell) => shell.plans)) as typeof plan.plans,
    [plan.plans, remote]
  )
  const pendingPlanIds = useMemo(
    () => new Set([...plan.pendingPlanIds, ...Object.values(remote).flatMap((shell) => [...shell.pendingPlanIds])]),
    [plan.pendingPlanIds, remote]
  )
  const [dialogWs, setDialogWs] = useState<string | null>(null)

  const [branchDialogWs, setBranchDialogWs] = useState<string | null>(null)
  // Whether the sidebar's list panel is open; its icon rail always stays. Remembered across launches.
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('sidebar.collapsed') !== '1')
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarOpen(!collapsed)
    localStorage.setItem('sidebar.collapsed', collapsed ? '1' : '0')
  }, [])
  // Settings take the whole window beside the rail; the remembered preference returns when they close.
  const sidebarPanelOpen = sidebarOpen && !settingsOpen
  const handleSidebarCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (settingsOpen && !collapsed) {
        requestMainNavigation(() => {
          setSettingsOpen(false)
          setSidebarCollapsed(false)
        })
        return
      }
      setSidebarCollapsed(collapsed)
    },
    [settingsOpen, setSettingsOpen, setSidebarCollapsed]
  )

  const [openTargets, setOpenTargets] = useState<{ vscode: boolean }>({ vscode: false })
  const migration = useConversationMigration({
    active: activeLocal,
    refreshWorkspaces,
    focusConversation: handleSelect,
  })
  // A moved conversation is shown once its new host lists it, which a remote host does a render after it answers.
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null)
  useEffect(() => {
    if (!pendingFocusKey) return
    const moved = everyHostWorkspaces
      .flatMap((workspace) => workspace.conversations)
      .find((conversation) => conversation.id === pendingFocusKey)
    if (!moved) return
    setPendingFocusKey(null)
    handleSelect(moved)
  }, [pendingFocusKey, everyHostWorkspaces, handleSelect])
  const refreshHost = useCallback(
    (hostId: HostId): Promise<unknown> =>
      hostId === LOCAL_HOST_ID ? refreshWorkspaces() : (remoteRef.current[hostId]?.actions.refresh() ?? Promise.resolve()),
    [refreshWorkspaces]
  )
  const move = useConversationMove({ refreshHost, focusConversationKey: setPendingFocusKey })
  const hostLabel = useCallback(
    (hostId: HostId): string => {
      const view = hostViews.get(hostId)
      return view ? hostName(view, t) : hostId
    },
    [hostViews, t]
  )
  useEffect(() => {
    api.getOpenTargets().then((t) => setOpenTargets({ vscode: t.vscode }))
  }, [api])

  useEffect(() => {
    if (!active) return
    setMountedConvs((prev) => {
      const i = prev.findIndex((c) => c.id === active.id)
      const next =
        i === -1 ? [...prev, active] : prev.map((conversation, index) => (index === i ? active : conversation))

      if (i !== -1) {
        next.splice(i, 1)
        next.push(active)
      }
      return next
    })
  }, [active])

  useEffect(() => {
    if (!active) return
    lastVisibleAtRef.current[active.id] = Date.now()
  }, [active?.id])

  // Conversation state the main process moved — a bot paused, a chat released — reaches the open chat
  // itself, not only the sidebar: the composer and its notices read this object.
  useEffect(
    () =>
      api.onConversationOpen(({ conversation }) => {
        if (!conversation?.id) return
        setActive((current) => (current?.id === conversation.id ? conversation : current))
        setMountedConvs((current) => current.map((item) => (item.id === conversation.id ? conversation : item)))
      }),
    [api]
  )

  useEffect(() => {
    return (
      window.api.onMemoryPressure?.((event) => {
        setHardPressure(autoReclaimEnabled === true && event.level === 'hard')
      }) ?? (() => {})
    )
  }, [autoReclaimEnabled])

  useEffect(() => {
    if (autoReclaimEnabled !== true) setHardPressure(false)
  }, [autoReclaimEnabled])

  useEffect(() => {
    if (autoReclaimEnabled !== true) return
    setMountedConvs((prev) =>
      pruneMountedChatViews(prev, statuses, active?.id ?? null, unsafeChatIds, undefined, undefined, {
        autoReclaimEnabled,
        lastVisibleAt: lastVisibleAtRef.current,
        hardPressure,
        protectedIds: protectedChatIds,
      })
    )
  }, [active?.id, autoReclaimEnabled, hardPressure, protectedChatIds, statuses, mountedConvs.length, unsafeChatIds])

  useEffect(() => {
    if (autoReclaimEnabled !== true) return
    const timer = window.setInterval(
      () => {
        setMountedConvs((prev) =>
          pruneMountedChatViews(prev, statuses, active?.id ?? null, unsafeChatIds, undefined, undefined, {
            autoReclaimEnabled,
            lastVisibleAt: lastVisibleAtRef.current,
            hardPressure,
            protectedIds: protectedChatIds,
          })
        )
      },
      Math.min(30_000, CHAT_VIEW_COLD_TTL_MS)
    )
    return () => window.clearInterval(timer)
  }, [active?.id, autoReclaimEnabled, hardPressure, protectedChatIds, statuses, unsafeChatIds])

  useEffect(() => {
    const live = new Set(allConversations.map((c) => c.id))
    // A remote host's list reaches the window a render after the host answered: a conversation just created or
    // opened there stays mounted meanwhile.
    if (active && isRemoteKey(active.id)) live.add(active.id)
    setMountedConvs((prev) => (prev.some((c) => !live.has(c.id)) ? prev.filter((c) => live.has(c.id)) : prev))
    // This computer does not store a remote host's conversations: one that left the window's lists (deleted, archived
    // or moved there, or its host disconnected) has its popups, floating windows and views closed here.
    for (const id of remoteListedRef.current) if (!live.has(id)) window.api.drawerDisposeConversation(id)
    remoteListedRef.current = new Set([...live].filter(isRemoteKey))
    const pruneDead = <T,>(prev: Record<string, T>): Record<string, T> => {
      const dead = Object.keys(prev).filter((id) => !live.has(id))
      if (dead.length === 0) return prev
      const next = { ...prev }
      for (const id of dead) delete next[id]
      return next
    }
    setDrawerOpenByConv(pruneDead)
    setDrawerTabByConv(pruneDead)
    setOpenTabsByConv(pruneDead)
    setDrawerWidthByConv(pruneDead)
    setDrawerFullByConv(pruneDead)

    hydrateOpenTabs(
      allConversations.map((conv) => ({
        conv,
        openTabs: conv.uiPrefs?.openTabs,
        activeTab: conv.uiPrefs?.activeTab,
      }))
    )

    setMainTabOrderByConv((prev) => {
      let next = prev
      for (const conv of allConversations) {
        if (next[conv.id]) continue
        const saved = conv.uiPrefs?.mainTabOrder
        if (saved?.length) {
          if (next === prev) next = { ...prev }
          next[conv.id] = sanitizeMainOrder(saved, conv)
        }
      }
      return pruneDead(next)
    })
  }, [allConversations, active?.id])

  useEffect(
    () => window.api.onWindowFullscreen((full) => document.documentElement.classList.toggle('is-fullscreen', full)),
    []
  )

  useEffect(() => {
    window.api.setVisibleConversation(mainOverride ? null : (active?.id ?? null))
  }, [active?.id, mainOverride])

  // Example: window.__sendToActive('\x1b[I')  |  window.__sendToActive('\x1b[200~hello\x1b[201~\r')
  useEffect(() => {
    ;(window as unknown as { __sendToActive?: (d: string) => void }).__sendToActive = (d) => {
      if (!active) return
      const target = hostTarget(active.id)
      target.api.writePty(target.id, d)
    }
  }, [active])

  const [aboutOpen, setAboutOpen] = useState(false)

  const overlaysSuspendNativeViews =
    dialogWs !== null ||
    projectSetup.state.open ||
    aboutOpen ||
    migration.dialog.open ||
    migration.recoveriesChecking ||
    migration.blockingRecoveries.length > 0 ||
    migration.recoveryError !== null ||
    move.state.kind !== 'idle' ||
    move.recoveries.length > 0
  useEffect(() => {
    window.api.popupSetSuppressed(overlaysSuspendNativeViews)
  }, [overlaysSuspendNativeViews])

  const handleNewSiblingConversation = useCallback(
    async (sourceConvId: string) => {
      try {
        if (isRemoteKey(sourceConvId)) {
          const created = await remoteRef.current[hostOfKey(sourceConvId)]?.actions.newSiblingConversation(sourceConvId)
          if (created) handleSelect(created)
          return
        }
        const conv = await api.createSiblingConversation({ sourceConversationId: sourceConvId })
        await refreshWorkspaces()
        handleSelect(conv)
      } catch (e: any) {
        const error = String(e?.message ?? e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
        alert(i18n.t('ui:app.alertNewSibling', { error }))
      }
    },
    [refreshWorkspaces, handleSelect, api]
  )

  const retryHost = useCallback((hostId: HostId) => void window.api.hostsRetry(hostId), [])
  // A host's environment is its own server's, whichever server the Bots tab shows.
  const startHost = useCallback(
    (host: HostView) => {
      if (host.environment && host.serverId)
        void fleets.controller(host.serverId).environmentAction(host.environment.id, 'start')
    },
    [fleets]
  )
  const openServerPage = useCallback(() => openFleetView({ kind: 'server' }), [openFleetView])
  // A host's environment page has its lifecycle, settings and isolation; a host reached without a server has none.
  const manageHost = useCallback(
    (host: HostView) => {
      if (host.serverId) onBotsServer(host.serverId)
      if (host.environment) openFleetView({ kind: 'environment', environmentId: host.environment.id, tab: 'overview' })
      else openServerPage()
    },
    [onBotsServer, openFleetView, openServerPage]
  )
  const hostSections: SidebarHostSection[] = remoteHosts.map((host) => ({
    host,
    shell: remote[host.id] ?? null,
    creatingChat: creatingRemoteChat === host.id,
    onNewChat: () => void handleNewRemoteChat(host.id),
    onAddWorkspace: () => void requestProjectOn(host.id),
    onRetry: () => retryHost(host.id),
    onStart: () => startHost(host),
    onManage: () => manageHost(host),
  }))
  /** Runs an action of the sidebar on the host its conversation or workspace belongs to. */
  const onHost = (key: string, local: () => unknown, act: (actions: RemoteHostShell['actions']) => unknown): void => {
    if (!isRemoteKey(key)) void local()
    else if (remote[hostOfKey(key)]) void act(remote[hostOfKey(key)].actions)
  }
  const activeHostId = active ? hostOfKey(active.id) : LOCAL_HOST_ID
  const activeHost = activeRemote ? (hostViews.get(activeHostId) ?? null) : null
  const allWorkspaces = everyHostWorkspaces
  // The host whose personal memory is shown; this computer's once a server is no longer paired.
  const personalMemoryHost =
    memoryTarget?.kind === 'personal' ? (hostViews.get(memoryTarget.hostId) ?? hostViews.get(LOCAL_HOST_ID)) : undefined
  const dialogHostId = dialogWs ? hostOfKey(dialogWs) : LOCAL_HOST_ID
  const branchDialogWorkspace = allWorkspaces.find((w) => w.id === branchDialogWs)

  return (
    <SettingsProvider openSettings={openSettings}>
      <UpdateProvider>
        <OnboardingProvider isOpen={onboardingOpen} openOnboarding={openOnboarding}>
          <div
            className={cn(
              'relative flex h-full bg-background text-foreground',
              !sidebarPanelOpen && 'sidebar-collapsed'
            )}
          >
            {remoteHosts
              .filter((host) => host.state === 'online')
              .map((host) => (
                // One runtime per connection: a host that answers again is listed again from scratch.
                <RemoteHostRuntime
                  key={`${host.id}:${host.epoch}`}
                  hostId={host.id}
                  active={active}
                  setActive={setActive}
                  setMountedConvs={setMountedConvs}
                  mainOverride={mainOverride}
                  forgetConvDrawerState={forgetConvDrawerState}
                  openDrawerTab={openDrawerTab}
                  setDrawerOpenByConv={setDrawerOpenByConv}
                  onFocus={handleSelect}
                  onChange={onRemoteChange}
                />
              ))}
            <Sidebar
              workspaces={workspaces}
              standaloneConversations={standaloneConversations}
              standaloneArchivedCount={standaloneArchivedCount}
              onNewChat={handleNewChat}
              creatingChat={creatingChat}
              onReorderStandaloneConversations={handleReorderStandaloneConversations}
              statuses={statuses}
              attention={attention}
              activeId={active?.id ?? null}
              selectedConversation={active}
              requestedTab={fleetTabRequest ? { tab: 'bots', requestId: fleetTabRequest } : null}
              fleet={fleet}
              selectedFleet={
                fleetView?.kind === 'bot'
                  ? fleetView.botId
                  : fleetView?.kind === 'environment'
                    ? `environment:${fleetView.environmentId}`
                    : (fleetView?.kind ?? null)
              }
              onOpenFleetBot={openFleetBot}
              onOpenFleetEnvironment={openFleetEnvironment}
              onOpenFleetServer={() => openFleetView({ kind: 'server' })}
              onOpenFleetInbox={() => openFleetView({ kind: 'inbox' })}
              onOpenFleetOwnerMemory={() => openFleetView({ kind: 'memory' })}
              botServerConnected={fleet.state.connection.state === 'connected'}
              botPendingCount={fleet.state.snapshot.inbox.length}
              botUpdate={botUpdates.summary.pending ? 'pending' : botUpdates.summary.available ? 'available' : null}
              onCreateBot={() => {
                openCreateBot(null)
                setFleetTabRequest((value) => value + 1)
              }}
              onOpenBotSettings={() => openSettings('fleet')}
              focusedWorkspaceId={focusedWorkspaceId}
              pendingPlanIds={pendingPlanIds}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived((v) => !v)}
              onSelect={handleSidebarConversationSelect}
              onAddWorkspace={() => void requestProject()}
              hostSections={hostSections}
              localHost={hosts[0]}
              appVersion={appVersion}
              onRemoveWorkspace={(id) =>
                onHost(
                  id,
                  () => handleRemoveWorkspace(id),
                  (actions) => actions.removeWorkspace(id)
                )
              }
              onNewConversation={(wsId) => setDialogWs(wsId)}
              onOpenProjectNotes={(wsId) => {
                requestMainNavigation(() => {
                  setProjectNotesWs(wsId)
                  nav.setFleetView(null)
                  setCreateBot(false)
                  setProjectMemoryWs(null)
                  setSettingsOpen(false)
                  setArtifactsOpen(false)
                  setOnboardingOpen(false)
                })
              }}
              onOpenProjectMemory={(wsId) => {
                requestMainNavigation(() => {
                  setProjectMemoryWs(wsId)
                  nav.setFleetView(null)
                  setCreateBot(false)
                  setProjectNotesWs(null)
                  setSettingsOpen(false)
                  setArtifactsOpen(false)
                  setOnboardingOpen(false)
                })
              }}
              onEditDefaultBranch={(wsId) => setBranchDialogWs(wsId)}
              onOpenAbout={() => setAboutOpen(true)}
              onRenameConversation={(conv, name) =>
                onHost(
                  conv.id,
                  () => handleRename(conv, name),
                  (actions) => actions.renameConversation(conv, name)
                )
              }
              onArchiveConversation={(conv, archived) =>
                onHost(
                  conv.id,
                  () => handleArchive(conv, archived),
                  (actions) => actions.archiveConversation(conv, archived)
                )
              }
              onPinConversation={(conv, pinned) =>
                isRemoteKey(conv.id)
                  ? remote[hostOfKey(conv.id)]?.actions.pinConversation(conv, pinned)
                  : handlePinConversation(conv, pinned)
              }
              onDeleteConversation={(conv) =>
                onHost(
                  conv.id,
                  () => handleDelete(conv),
                  (actions) => actions.deleteConversation(conv)
                )
              }
              onMigrateConversation={migration.openMigration}
              moveTargetsOf={(conv) => moveTargetsFor(conv.id, hosts)}
              onMoveConversation={move.open}
              onNewSiblingConversation={handleNewSiblingConversation}
              onArchiveSiblings={(members, archived) =>
                onHost(
                  members[0]?.id ?? '',
                  () => handleArchiveSiblings(members, archived),
                  (actions) => actions.archiveSiblings(members, archived)
                )
              }
              onDeleteSiblings={(members) =>
                onHost(
                  members[0]?.id ?? '',
                  () => handleDeleteSiblings(members),
                  (actions) => actions.deleteSiblings(members)
                )
              }
              onReorderWorkspaces={handleReorderWorkspaces}
              onReorderConversations={(workspaceId, ids) =>
                onHost(
                  workspaceId,
                  () => handleReorderConversations(workspaceId, ids),
                  (actions) => actions.reorderConversations(workspaceId, ids)
                )
              }
              groups={groups}
              onCreateGroup={handleCreateGroup}
              onRenameGroup={handleRenameGroup}
              onDeleteGroup={handleDeleteGroup}
              onReorderGroups={handleReorderGroups}
              onToggleGroupCollapsed={handleToggleGroupCollapsed}
              onMoveWorkspaceToGroup={handleMoveWorkspaceToGroup}
              onToggleWorkspaceCollapsed={(id) =>
                onHost(
                  id,
                  () => handleToggleWorkspaceCollapsed(id),
                  (actions) => actions.toggleWorkspaceCollapsed(id)
                )
              }
              collapsed={!sidebarPanelOpen}
              onCollapsedChange={handleSidebarCollapsedChange}
              openTargets={openTargets}
              onOpenExternal={(scope, id, target) =>
                void api.openExternal(scope, id, target).then((r) => {
                  if (!r.ok) console.error('[open-external]', target, r.error)
                })
              }
            />

            <main
              ref={mainRef}
              className="flex min-w-0 flex-1 flex-col"
              style={fullActive && !mainOverride ? { display: 'none' } : undefined}
            >
              {projectNotesWs && (
                <HostProvider hostId={hostOfKey(projectNotesWs)}>
                  <ProjectNotesView
                    workspaceId={rawId(projectNotesWs)}
                    workspaceName={allWorkspaces.find((w) => w.id === projectNotesWs)?.name ?? ''}
                    onClose={() => setProjectNotesWs(null)}
                  />
                </HostProvider>
              )}
              {personalMemoryHost && (
                // Mounted again for another host, and for a host that answers again.
                <HostProvider
                  key={`${personalMemoryHost.id}:${personalMemoryHost.epoch}`}
                  hostId={personalMemoryHost.id}
                >
                  <PersonalMemoryView
                    focusMemoryId={focusMemoryId}
                    focusMemoryRequest={focusMemoryRequest}
                    onHostChange={showPersonalMemoryOf}
                    onClose={() => setProjectMemoryWs(null)}
                  />
                </HostProvider>
              )}
              {memoryTarget?.kind === 'workspace' && (
                <HostProvider hostId={hostOfKey(memoryTarget.workspaceId)}>
                  <ProjectMemoryView
                    workspaceId={rawId(memoryTarget.workspaceId)}
                    focusMemoryId={focusMemoryId}
                    focusMemoryRequest={focusMemoryRequest}
                    workspaceName={allWorkspaces.find((w) => w.id === memoryTarget.workspaceId)?.name ?? ''}
                    onClose={() => setProjectMemoryWs(null)}
                  />
                </HostProvider>
              )}
              {settingsOpen && (
                <SettingsView
                  fleet={fleet}
                  initialSection={settingsSection}
                  request={settingsRequest}
                  onClose={() => setSettingsOpen(false)}
                />
              )}
              {artifactsOpen && (
                <ArtifactsCenter
                  onOpenBot={openFleetBot}
                  onClose={() => setArtifactsOpen(false)}
                  onOpenSettings={() => openSettings('artifacts')}
                />
              )}
              <PersistentBotViews
                fleets={fleets}
                view={fleetView}
                fleet={fleet}
                onView={openFleetView}
                onOpenBot={openFleetBot}
              />
              {fleetView?.kind === 'environment' &&
                fleet.state.snapshot.environments.some((environment) => environment.id === fleetView.environmentId) && (
                  <EnvironmentView
                    environment={
                      fleet.state.snapshot.environments.find(
                        (environment) => environment.id === fleetView.environmentId
                      )!
                    }
                    view={fleetView}
                    fleet={fleet}
                    onView={openFleetView}
                    onOpenBot={openFleetBot}
                    onCreateBot={(environmentId) => openCreateBot(environmentId)}
                  />
                )}
              {fleetView?.kind === 'server' && (
                <ServerView fleet={fleet} onOpenBot={openFleetBot} onOpenEnvironment={openFleetEnvironment} />
              )}
              {fleetView?.kind === 'inbox' && <InboxView fleet={fleet} onOpenBot={openFleetBot} />}
              {fleetView?.kind === 'memory' && <OwnerMemoryView fleet={fleet} onOpenBot={openFleetBot} />}
              <CreateBotDialog
                open={createBot}
                onClose={() => setCreateBot(false)}
                fleet={fleet}
                initialEnvironmentId={createBotEnvironmentId}
                onCreated={(id) => {
                  setCreateBot(false)
                  openFleetBot(id)
                }}
              />
              {onboardingOpen && (
                <OnboardingFlow
                  workspaces={workspaces}
                  onNewChat={handleNewChat}
                  creatingChat={creatingChat}
                  onAddWorkspace={requestProject}
                  onCreateConversation={(wsId) => setDialogWs(wsId)}
                  onClose={completeOnboarding}
                />
              )}

              <div className="flex min-h-0 flex-1 flex-col" style={mainOverride ? { display: 'none' } : undefined}>
                <header className="drag flex h-10 shrink-0 items-center justify-between gap-2 hairline-b pl-[var(--view-header-inset)] pr-2">
                  <div className="no-drag flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                    <span className="truncate text-[13px] font-medium text-foreground/90">{active?.name ?? ''}</span>
                    {active?.botOrigin && <BotConversationBadge conversation={active} />}
                    {active?.scope === 'project' && (
                      <HostProvider hostId={activeHostId}>
                        <ConversationBranchChip conversationId={rawId(active.id)} status={statuses[active.id]} />
                      </HostProvider>
                    )}
                  </div>
                  <div className="no-drag flex min-w-0 items-center gap-2">
                    {active && !activeRemote && <ChatWindowButton target={{ kind: 'conversation', id: active.id }} />}
                    {active?.botOrigin && (
                      <HostProvider hostId={activeHostId}>
                        <BotManagementControls conversation={hostConversation(active)} />
                      </HostProvider>
                    )}
                    {active?.scope === 'project' && active.archived === 0 && !active.isMulti && !active.botOrigin && (
                      <HostProvider hostId={activeHostId}>
                        <ReviewHeaderButton conversationId={rawId(active.id)} hostId={activeHostId} />
                      </HostProvider>
                    )}
                    <Button
                      variant={drawerOpen ? 'secondary' : 'ghost'}
                      size="icon"
                      className="size-7 shrink-0"
                      onClick={() => setDrawerOpen((v) => !v)}
                      title={t('app.toggleDrawer', { shortcut: drawerShortcutLabel })}
                    >
                      <PanelRight className="size-4" />
                    </Button>
                  </div>
                </header>

                <div className="relative min-h-0 flex-1">
                  {mountedConvs.map((c) => {
                    const currentConversation = allConversations.find((conversation) => conversation.id === c.id) ?? c
                    const chatHostId = hostOfKey(c.id)
                    const chatHost = chatHostId === LOCAL_HOST_ID ? null : (hostViews.get(chatHostId) ?? null)
                    return (
                      // Inactive conversations use display:none; terminal views must refit when shown.

                      <div
                        key={c.id}
                        className="absolute inset-0"
                        style={{ display: active?.id === c.id ? undefined : 'none' }}
                      >
                        {chatHost ? (
                          // Only this computer's conversations open in windows of their own.
                          <>
                            <HostProvider hostId={chatHostId}>
                              <ChatView
                                // A remote host's conversation is loaded again each time the host answers again.
                                key={`${c.id}@${chatHost.epoch}`}
                                conversationId={rawId(c.id)}
                                conversationName={currentConversation.name}
                                onOpenPlan={() => {
                                  openDrawerTab(c.id, 'plan')
                                  setDrawerOpenByConv((current) => ({ ...current, [c.id]: true }))
                                }}
                                workspaceId={c.workspaceId === null ? null : rawId(c.workspaceId)}
                                cwd={c.cwd}
                                experience={c.experience}
                                botManaged={
                                  !!currentConversation.botOrigin && currentConversation.botManagementState === 'active'
                                }
                                botConversation={
                                  currentConversation.botOrigin ? hostConversation(currentConversation) : undefined
                                }
                                botName={currentConversation.botOrigin?.botName}
                                onExperienceChange={(id, experience) =>
                                  handleConversationExperienceChange(hostKey(chatHostId, id), experience)
                                }
                                visible={active?.id === c.id && !mainOverride}
                                status={statuses[c.id] ?? c.status}
                                onEvictionSafetyChange={(id, safe) =>
                                  onChatEvictionSafetyChange(hostKey(chatHostId, id), safe)
                                }
                              />
                            </HostProvider>
                            <HostUnavailableOverlay
                              host={chatHost}
                              onRetry={() => retryHost(chatHost.id)}
                              onStart={() => startHost(chatHost)}
                              onManage={() => manageHost(chatHost)}
                            />
                          </>
                        ) : (
                          <ChatWindowHost
                            target={{ kind: 'conversation', id: c.id }}
                            title={[
                              workspaces.find((workspace) => workspace.id === c.workspaceId)?.name,
                              currentConversation.name,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                            onReattach={() => handleSidebarConversationSelect(currentConversation)}
                            onShowSource={() => handleSidebarConversationSelect(currentConversation)}
                            actions={
                              <Button
                                variant="ghost"
                                size={pendingPlanIds.has(c.id) ? 'sm' : 'icon'}
                                className={pendingPlanIds.has(c.id) ? 'h-7 gap-1.5 px-2 text-xs' : 'size-7'}
                                title={t(pendingPlanIds.has(c.id) ? 'chatWindow.plan' : 'chatWindow.tools')}
                                onClick={() => {
                                  handleSidebarConversationSelect(currentConversation)
                                  if (pendingPlanIds.has(c.id)) openDrawerTab(c.id, 'plan')
                                  setDrawerOpenByConv((current) => ({ ...current, [c.id]: true }))
                                  void window.api.chatWindowShowSource(`conversation:${c.id}`)
                                }}
                              >
                                <PanelRight className="size-4" />
                                {pendingPlanIds.has(c.id) && t('chatWindow.plan')}
                              </Button>
                            }
                          >
                            {(detached) => (
                              <ChatView
                                key={c.id}
                                conversationId={c.id}
                                conversationName={currentConversation.name}
                                onOpenPlan={() => {
                                  openDrawerTab(c.id, 'plan')
                                  setDrawerOpenByConv((current) => ({ ...current, [c.id]: true }))
                                }}
                                workspaceId={c.workspaceId}
                                cwd={c.cwd}
                                experience={c.experience}
                                botManaged={
                                  !!currentConversation.botOrigin && currentConversation.botManagementState === 'active'
                                }
                                botConversation={currentConversation.botOrigin ? currentConversation : undefined}
                                botName={currentConversation.botOrigin?.botName}
                                onExperienceChange={handleConversationExperienceChange}
                                visible={detached || (active?.id === c.id && !mainOverride)}
                                status={statuses[c.id] ?? c.status}
                                onEvictionSafetyChange={onChatEvictionSafetyChange}
                              />
                            )}
                          </ChatWindowHost>
                        )}
                      </div>
                    )
                  })}
                  {!active && onboardingChecked && (
                    <div className="flex h-full flex-col items-center justify-center gap-3.5 text-muted-foreground">
                      <div className="flex size-14 items-center justify-center rounded-2xl bg-white/[0.04] ring-1 ring-white/[0.06]">
                        <MessagesSquare className="size-7 opacity-60" />
                      </div>
                      <p className="text-sm">{t('app.emptyState')}</p>
                      <Button disabled={creatingChat} onClick={() => void handleNewChat()}>
                        {t('sidebar.newChat')}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </main>

            {active && (
              <>
                {drawerOpen && !fullActive && !mainOverride && (
                  <div
                    onMouseDown={() => {
                      dragging.current = true
                      document.body.style.cursor = 'col-resize'
                      document.body.style.userSelect = 'none'
                    }}
                    className="w-1 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-primary/60"
                    title={t('app.dragToResize')}
                  />
                )}
                <div
                  className={cn('flex flex-col', fullActive ? 'min-w-0 flex-1' : 'shrink-0')}
                  style={{
                    width: fullActive ? undefined : drawerWidth,
                    display: drawerOpen && !mainOverride ? undefined : 'none',
                  }}
                >
                  <HostProvider hostId={activeHostId}>
                    <Drawer
                      activeConv={active}
                      visible={drawerOpen && !mainOverride}
                      // The panels of a host that is away show nothing useful: the overlay of its chat says why.
                      suspended={overlaysSuspendNativeViews || (activeHost !== null && activeHost.state !== 'online')}
                      onClose={() => setDrawerOpen(false)}
                      isFull={fullActive}
                      onToggleFull={toggleDrawerFull}
                      activePlan={plans[active.id] ?? null}
                      tab={drawerTab}
                      onTabChange={setActiveDrawerTab}
                      openTabs={openTabs}
                      onCloseTab={closeDrawerTab}
                      onReorderOpenTabs={reorderOpenTabs}
                      catalogOrder={mainTabOrder}
                      chatGptWebEnabled={chatGptWebEnabled && !activeRemote}
                    />
                  </HostProvider>
                </div>
              </>
            )}

            <ConversationMigrationDialog
              state={migration.dialog}
              onDestinationBranchChange={migration.setDestinationBranch}
              onPrepare={() => void migration.prepare()}
              onClose={() => void migration.closeMigration()}
              onEditBranch={() => void migration.editDestinationBranch()}
              onIgnoredChange={migration.toggleIgnored}
              onSensitiveConfirmationChange={migration.confirmSensitive}
              onExecute={() => void migration.execute()}
            />

            <ConversationMoveDialog
              state={move.state}
              hostLabel={hostLabel}
              onClose={move.close}
              onExecute={move.execute}
              onBranchChange={move.editBranch}
              onApplyBranch={move.applyBranch}
              onToggleIgnored={move.toggleIgnored}
              onConfirmSensitive={move.confirmSensitive}
              onResolve={move.resolveInDialog}
            />

            <HostProvider hostId={dialogHostId}>
              {/* The dialog works with its host's own ids; the window's are turned into them and back. */}
              <NewConversationDialog
                workspaceId={dialogWs === null ? null : rawId(dialogWs)}
                workspaces={
                  dialogHostId === LOCAL_HOST_ID
                    ? workspaces
                    : (remote[dialogHostId]?.workspaces ?? []).map(hostWorkspace)
                }
                requestProject={() => requestProjectOn(dialogHostId)}
                open={dialogWs !== null}
                onOpenChange={(o) => !o && setDialogWs(null)}
                onCreated={
                  dialogHostId === LOCAL_HOST_ID
                    ? handleCreated
                    : (conversation) => void handleRemoteCreated(dialogHostId, conversation)
                }
              />
            </HostProvider>

            <HostProvider hostId={projectHost}>
              <ProjectSetupDialog
                state={projectSetup.state}
                onModeChange={projectSetup.setMode}
                onStart={projectSetup.start}
                onResolveEmptyRemote={projectSetup.resolveEmptyRemote}
                onClose={projectSetup.close}
              />
            </HostProvider>

            <HostProvider hostId={branchDialogWs ? hostOfKey(branchDialogWs) : LOCAL_HOST_ID}>
              <WorkspaceDefaultBranchDialog
                workspaceId={branchDialogWs === null ? null : rawId(branchDialogWs)}
                workspaceName={branchDialogWorkspace?.name}
                currentDefault={branchDialogWorkspace?.defaultBranch ?? ''}
                open={branchDialogWs !== null}
                onOpenChange={(o) => !o && setBranchDialogWs(null)}
                onSaved={() =>
                  onHost(
                    branchDialogWs ?? '',
                    () => refreshWorkspaces(),
                    (actions) => actions.refresh()
                  )
                }
              />
            </HostProvider>

            <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

            <MigrationRecoveryGate
              checking={migration.recoveriesChecking}
              recoveries={migration.blockingRecoveries}
              error={migration.recoveryError}
              resolving={migration.resolvingRecovery}
              onResolve={(recovery, action) => void migration.resolveRecovery(recovery, action)}
              onRetry={() => void migration.retryRecoveries()}
            />

            <ConversationMoveRecoveryGate
              recoveries={move.recoveries}
              error={move.recoveryError}
              resolving={move.resolving}
              hostLabel={hostLabel}
              onResolve={move.resolveRecovery}
              onRetry={move.retryRecoveries}
            />

            <PopupOverlay convId={mainOverride ? null : (active?.id ?? null)} />
          </div>
        </OnboardingProvider>
      </UpdateProvider>
    </SettingsProvider>
  )
}
