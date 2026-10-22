/** Coordinate mutually exclusive project panels, settings, and onboarding. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type SyntheticEvent,
} from 'react'
import type { Conversation, WorkspaceWithConversations } from '../../preload'
import { requestMainNavigation } from './main-navigation'
import type { SettingsSection } from '@/components/settings/nav'
import type { OpenSettingsOptions, SettingsRequest } from './use-settings'
import { hostApi } from '@/lib/hosts/host-context'
import { type HostId, LOCAL_HOST_ID, parseHostKey } from '../../shared/host-key'
import { memoryKeyFor, memoryTargetOf, type OpenMemoryRequest, personalMemoryKey } from './memory-target'
import type { EnvironmentSettingsSection } from '@/components/fleet/environment-settings/sections'

export type FleetView =
  /** `runs` shows the bot's routine runs, `runId` one of them. */
  | { kind: 'bot'; botId: string; tab: 'conversation' | 'screen' | 'settings' | 'runs'; runId?: string }
  | {
      kind: 'environment'
      environmentId: string
      tab: 'overview' | 'screen' | 'settings'
      section?: EnvironmentSettingsSection
    }
  | { kind: 'server' }
  | { kind: 'inbox' }
  | { kind: 'memory' }

type UseMainPanelsParams = {
  /** Chats and workspaces of every host, keyed for the window: links to a conversation or its memory find it here. */
  standaloneConversations: Conversation[]
  workspaces: WorkspaceWithConversations[]
  setActive: Dispatch<SetStateAction<Conversation | null>>
  refreshWorkspaces: () => Promise<WorkspaceWithConversations[]>
  /** Lists a host again, in shell form; a link to a conversation another host just created looks for it there. */
  refreshHostWorkspaces?: (hostId: HostId) => Promise<WorkspaceWithConversations[]>
  hostId?: HostId
}

export function useMainPanels({
  workspaces,
  standaloneConversations,
  setActive,
  refreshWorkspaces,
  refreshHostWorkspaces,
  hostId = LOCAL_HOST_ID,
}: UseMainPanelsParams) {
  const api = hostApi(hostId)
  const [projectNotesWs, setProjectNotesWs] = useState<string | null>(null)
  const [projectMemoryWs, setProjectMemoryWs] = useState<string | null>(null)
  const [focusMemoryRequest, setFocusMemoryRequest] = useState(0)
  const [focusMemoryId, setFocusMemoryId] = useState<string | undefined>()
  useEffect(() => {
    if (!projectMemoryWs) setFocusMemoryId(undefined)
  }, [projectMemoryWs])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [fleetView, setFleetView] = useState<FleetView | null>(null)
  const [createBot, setCreateBot] = useState(false)
  // The environment a new bot joins when created from its environment view; null offers a new environment.
  const [createBotEnvironmentId, setCreateBotEnvironmentId] = useState<string | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('chat')
  // Bumped on every request for a chat tab, so asking again for the same tab still shows it.
  const [settingsRequest, setSettingsRequest] = useState<SettingsRequest | null>(null)
  const settingsRequestSeq = useRef(0)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingChecked, setOnboardingChecked] = useState(false)
  const onboardingOpenRef = useRef(false)
  onboardingOpenRef.current = onboardingOpen

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenMemoryRequest>).detail
      if (!detail) return
      const key = memoryKeyFor(detail, workspaces, standaloneConversations)
      if (!key) return
      setProjectNotesWs(null)
      setFleetView(null)
      setCreateBot(false)
      setSettingsOpen(false)
      setArtifactsOpen(false)
      setOnboardingOpen(false)
      setFocusMemoryId(detail.memoryId)
      setFocusMemoryRequest((value) => value + 1)
      setProjectMemoryWs(key)
    }
    window.addEventListener('maestrly:open-memory', open)
    return () => window.removeEventListener('maestrly:open-memory', open)
  }, [workspaces, standaloneConversations])

  // Links to other conversations (e.g. conversations started by start_conversations) focus them in place.
  useEffect(() => {
    const open = async (event: Event) => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId
      if (!conversationId) return
      const find = (items: WorkspaceWithConversations[]) =>
        items.flatMap((item) => item.conversations).find((conversation) => conversation.id === conversationId)
      const owner = parseHostKey(conversationId).hostId
      const relist = () =>
        owner === LOCAL_HOST_ID || !refreshHostWorkspaces ? refreshWorkspaces() : refreshHostWorkspaces(owner)
      const conversation =
        standaloneConversations.find((item) => item.id === conversationId) ??
        find(workspaces) ??
        find(await relist())
      if (!conversation) return
      setFleetView(null)
      setCreateBot(false)
      setProjectNotesWs(null)
      setProjectMemoryWs(null)
      setSettingsOpen(false)
      setArtifactsOpen(false)
      setOnboardingOpen(false)
      setActive(conversation)
    }
    const listener = (event: Event) => void open(event)
    window.addEventListener('maestrly:open-conversation', listener)
    return () => window.removeEventListener('maestrly:open-conversation', listener)
  }, [refreshWorkspaces, refreshHostWorkspaces, setActive, workspaces, standaloneConversations])

  /** Shows the personal memory of another host in the open memory center. */
  const showPersonalMemoryOf = useCallback((memoryHostId: HostId) => {
    setFocusMemoryId(undefined)
    setProjectMemoryWs(personalMemoryKey(memoryHostId))
  }, [])

  const mainOverride =
    projectNotesWs ||
    projectMemoryWs ||
    (settingsOpen ? 'settings' : null) ||
    (artifactsOpen ? 'artifacts' : null) ||
    (onboardingOpen ? 'onboarding' : null) ||
    (fleetView ? 'fleet' : null) ||
    (createBot ? 'fleet-create' : null)

  useEffect(
    () =>
      api.onConversationOpen(async ({ conversation, focus }) => {
        await refreshWorkspaces()
        if (!focus) return
        requestMainNavigation(() => {
          setProjectNotesWs(null)
          setProjectMemoryWs(null)
          setSettingsOpen(false)
          setArtifactsOpen(false)
          setOnboardingOpen(false)
          setFleetView(null)
          setCreateBot(false)
          setActive(conversation)
        })
      }),
    [refreshWorkspaces, setActive, api]
  )

  const handleCreated = useCallback(
    async (conversation: Conversation) => {
      await refreshWorkspaces()
      requestMainNavigation(() => {
        setSettingsOpen(false)
        setArtifactsOpen(false)
        if (onboardingOpenRef.current) {
          window.api.setOnboardingDone(true)
          setOnboardingOpen(false)
        }
        setFleetView(null)
        setCreateBot(false)
        setActive(conversation)
      })
    },
    [refreshWorkspaces, setActive]
  )

  const openSettings = useCallback(
    (sectionOrEvent: SettingsSection | SyntheticEvent = 'chat', options?: OpenSettingsOptions) => {
      const section = typeof sectionOrEvent === 'string' ? sectionOrEvent : 'chat'
      requestMainNavigation(() => {
        setFleetView(null)
        setCreateBot(false)
        setSettingsSection(section)
        // A plain request clears the last one, so Settings opened again later starts where it is asked to.
        setSettingsRequest(
          options?.chatTab || options?.hostId || options?.connectComputer || options?.fleetServer
            ? {
                section,
                ...(options.chatTab ? { chatTab: options.chatTab } : {}),
                ...(options.hostId ? { hostId: options.hostId } : {}),
                ...(options.connectComputer ? { connectComputer: options.connectComputer } : {}),
                ...(options.fleetServer ? { fleetServer: options.fleetServer } : {}),
                seq: ++settingsRequestSeq.current,
              }
            : null
        )
        setProjectNotesWs(null)
        setProjectMemoryWs(null)
        setOnboardingOpen(false)
        setArtifactsOpen(false)
        setSettingsOpen(true)
      })
    },
    []
  )

  const openArtifacts = useCallback(() => {
    requestMainNavigation(() => {
      setFleetView(null)
      setCreateBot(false)
      setProjectNotesWs(null)
      setProjectMemoryWs(null)
      setOnboardingOpen(false)
      setSettingsOpen(false)
      setArtifactsOpen(true)
    })
  }, [])

  useEffect(() => {
    window.addEventListener('maestrly:open-artifacts', openArtifacts)
    return () => window.removeEventListener('maestrly:open-artifacts', openArtifacts)
  }, [openArtifacts])

  const openOnboarding = useCallback(() => {
    requestMainNavigation(() => {
      setProjectNotesWs(null)
      setProjectMemoryWs(null)
      setSettingsOpen(false)
      setArtifactsOpen(false)
      setFleetView(null)
      setCreateBot(false)
      setOnboardingOpen(true)
    })
  }, [])

  useEffect(() => {
    window.api
      .getOnboardingDone()
      .then((done) => {
        if (!done) openOnboarding()
      })
      .catch(() => {})
      .finally(() => setOnboardingChecked(true))
  }, [openOnboarding])

  const completeOnboarding = useCallback(() => {
    window.api.setOnboardingDone(true)
    setOnboardingOpen(false)
  }, [])

  const handleSelect = useCallback(
    (conversation: Conversation) => {
      requestMainNavigation(() => {
        setProjectNotesWs(null)
        setProjectMemoryWs(null)
        setSettingsOpen(false)
        setArtifactsOpen(false)
        setOnboardingOpen(false)
        setFleetView(null)
        setCreateBot(false)
        setActive(conversation)
      })
    },
    [setActive]
  )

  const openCreateBot = useCallback((environmentId: string | null = null) => {
    requestMainNavigation(() => {
      setCreateBotEnvironmentId(environmentId)
      setArtifactsOpen(false)
      setCreateBot(true)
    })
  }, [])

  const openFleetView = useCallback(
    (view: FleetView) => {
      requestMainNavigation(() => {
        setProjectNotesWs(null)
        setProjectMemoryWs(null)
        setSettingsOpen(false)
        setArtifactsOpen(false)
        setOnboardingOpen(false)
        setCreateBot(false)
        setActive(null)
        setFleetView(view)
      })
    },
    [setActive]
  )

  return {
    fleetView,
    setFleetView,
    createBot,
    setCreateBot,
    createBotEnvironmentId,
    openCreateBot,
    openFleetView,
    projectNotesWs,
    setProjectNotesWs,
    projectMemoryWs,
    memoryTarget: memoryTargetOf(projectMemoryWs),
    showPersonalMemoryOf,
    focusMemoryId,
    focusMemoryRequest,
    setProjectMemoryWs,
    settingsOpen,
    setSettingsOpen,
    artifactsOpen,
    setArtifactsOpen,
    openArtifacts,
    settingsSection,
    settingsRequest,
    onboardingOpen,
    setOnboardingOpen,
    onboardingChecked,
    mainOverride,
    openSettings,
    openOnboarding,
    handleSelect,
    handleCreated,
    completeOnboarding,
  }
}
