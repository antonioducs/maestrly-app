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
import type { SettingsSection } from '@/components/settings/nav'

export type FleetView =
  | { kind: 'bot'; botId: string; tab: 'conversation' | 'screen' | 'settings' }
  | { kind: 'server' }
  | { kind: 'inbox' }
  | { kind: 'memory' }

type UseMainPanelsParams = {
  workspaces: WorkspaceWithConversations[]
  setActive: Dispatch<SetStateAction<Conversation | null>>
  refreshWorkspaces: () => Promise<WorkspaceWithConversations[]>
}

export function useMainPanels({ workspaces, setActive, refreshWorkspaces }: UseMainPanelsParams) {
  const [projectNotesWs, setProjectNotesWs] = useState<string | null>(null)
  const [projectMemoryWs, setProjectMemoryWs] = useState<string | null>(null)
  const [focusMemoryId, setFocusMemoryId] = useState<string | undefined>()
  useEffect(() => {
    if (!projectMemoryWs) setFocusMemoryId(undefined)
  }, [projectMemoryWs])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [fleetView, setFleetView] = useState<FleetView | null>(null)
  const [createBot, setCreateBot] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('chat')
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingChecked, setOnboardingChecked] = useState(false)
  const onboardingOpenRef = useRef(false)
  onboardingOpenRef.current = onboardingOpen

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string; memoryId?: string }>).detail
      if (!detail?.conversationId) return
      const workspace = workspaces.find((item) =>
        item.conversations.some((conversation) => conversation.id === detail.conversationId)
      )
      if (!workspace) return
      setProjectNotesWs(null)
      setFleetView(null)
      setCreateBot(false)
      setSettingsOpen(false)
      setOnboardingOpen(false)
      setFocusMemoryId(detail.memoryId)
      setProjectMemoryWs(workspace.id)
    }
    window.addEventListener('maestrly:open-memory', open)
    return () => window.removeEventListener('maestrly:open-memory', open)
  }, [workspaces])

  // Links to other conversations (e.g. conversations started by start_conversations) focus them in place.
  useEffect(() => {
    const open = async (event: Event) => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId
      if (!conversationId) return
      const find = (items: WorkspaceWithConversations[]) =>
        items.flatMap((item) => item.conversations).find((conversation) => conversation.id === conversationId)
      const conversation = find(workspaces) ?? find(await refreshWorkspaces())
      if (!conversation) return
      setProjectNotesWs(null)
      setProjectMemoryWs(null)
      setSettingsOpen(false)
      setOnboardingOpen(false)
      setActive(conversation)
    }
    const listener = (event: Event) => void open(event)
    window.addEventListener('maestrly:open-conversation', listener)
    return () => window.removeEventListener('maestrly:open-conversation', listener)
  }, [refreshWorkspaces, setActive, workspaces])

  const mainOverride =
    projectNotesWs ||
    projectMemoryWs ||
    (settingsOpen ? 'settings' : null) ||
    (onboardingOpen ? 'onboarding' : null) ||
    (fleetView ? 'fleet' : null) ||
    (createBot ? 'fleet-create' : null)

  useEffect(
    () =>
      window.api.onConversationOpen(async ({ conversation, focus }) => {
        await refreshWorkspaces()
        if (!focus) return
        setProjectNotesWs(null)
        setProjectMemoryWs(null)
        setSettingsOpen(false)
        setOnboardingOpen(false)
        setFleetView(null)
        setCreateBot(false)
        setActive(conversation)
      }),
    [refreshWorkspaces, setActive]
  )

  const handleCreated = useCallback(
    async (conversation: Conversation) => {
      await refreshWorkspaces()
      setSettingsOpen(false)
      if (onboardingOpenRef.current) {
        window.api.setOnboardingDone(true)
        setOnboardingOpen(false)
      }
      setFleetView(null)
      setCreateBot(false)
      setActive(conversation)
    },
    [refreshWorkspaces, setActive]
  )

  const openSettings = useCallback((sectionOrEvent: SettingsSection | SyntheticEvent = 'chat') => {
    const section = typeof sectionOrEvent === 'string' ? sectionOrEvent : 'chat'
    setFleetView(null)
    setCreateBot(false)
    setSettingsSection(section)
    setProjectNotesWs(null)
    setProjectMemoryWs(null)
    setOnboardingOpen(false)
    setSettingsOpen(true)
  }, [])

  const openOnboarding = useCallback(() => {
    setProjectNotesWs(null)
    setProjectMemoryWs(null)
    setSettingsOpen(false)
    setFleetView(null)
    setCreateBot(false)
    setOnboardingOpen(true)
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
      setProjectNotesWs(null)
      setProjectMemoryWs(null)
      setSettingsOpen(false)
      setOnboardingOpen(false)
      setFleetView(null)
      setCreateBot(false)
      setActive(conversation)
    },
    [setActive]
  )

  const openFleetView = useCallback(
    (view: FleetView) => {
      setProjectNotesWs(null)
      setProjectMemoryWs(null)
      setSettingsOpen(false)
      setOnboardingOpen(false)
      setCreateBot(false)
      setActive(null)
      setFleetView(view)
    },
    [setActive]
  )

  return {
    fleetView,
    setFleetView,
    createBot,
    setCreateBot,
    openFleetView,
    projectNotesWs,
    setProjectNotesWs,
    projectMemoryWs,
    focusMemoryId,
    setProjectMemoryWs,
    settingsOpen,
    setSettingsOpen,
    settingsSection,
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
