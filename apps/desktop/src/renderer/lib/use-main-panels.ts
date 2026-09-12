/** Coordinate mutually exclusive project panels, settings, and onboarding. */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type SyntheticEvent } from 'react'
import type { Conversation, WorkspaceWithConversations } from '../../preload'
import type { SettingsSection } from '@/components/settings/nav'

type UseMainPanelsParams = {
  workspaces: WorkspaceWithConversations[]
  setActive: Dispatch<SetStateAction<Conversation | null>>
  refreshWorkspaces: () => Promise<WorkspaceWithConversations[]>
}

export function useMainPanels({ workspaces, setActive, refreshWorkspaces }: UseMainPanelsParams) {
  const [projectNotesWs, setProjectNotesWs] = useState<string | null>(null)
  const [projectMemoryWs, setProjectMemoryWs] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('chat')
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingChecked, setOnboardingChecked] = useState(false)
  const onboardingOpenRef = useRef(false)
  onboardingOpenRef.current = onboardingOpen

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail
      if (!detail?.conversationId) return
      const workspace = workspaces.find((item) =>
        item.conversations.some((conversation) => conversation.id === detail.conversationId)
      )
      if (!workspace) return
      setProjectNotesWs(null)
      setSettingsOpen(false)
      setOnboardingOpen(false)
      setProjectMemoryWs(workspace.id)
    }
    window.addEventListener('maestrly:open-memory', open)
    return () => window.removeEventListener('maestrly:open-memory', open)
  }, [workspaces])

  const mainOverride =
    projectNotesWs ||
    projectMemoryWs ||
    (settingsOpen ? 'settings' : null) ||
    (onboardingOpen ? 'onboarding' : null)

  useEffect(
    () =>
      window.api.onConversationOpen(async ({ conversation, focus }) => {
        await refreshWorkspaces()
        if (!focus) return
        setProjectNotesWs(null)
        setProjectMemoryWs(null)
        setSettingsOpen(false)
        setOnboardingOpen(false)
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
      setActive(conversation)
    },
    [refreshWorkspaces, setActive]
  )

  const openSettings = useCallback((sectionOrEvent: SettingsSection | SyntheticEvent = 'chat') => {
    const section = typeof sectionOrEvent === 'string' ? sectionOrEvent : 'chat'
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
      setActive(conversation)
    },
    [setActive]
  )

  return {
    projectNotesWs,
    setProjectNotesWs,
    projectMemoryWs,
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
