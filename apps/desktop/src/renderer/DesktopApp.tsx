/** Local desktop shell. Keep live conversations mounted while project panels replace the main view.
 * Native drawer and popup surfaces are suppressed whenever a DOM overlay needs to cover them. */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelRight, PanelLeft, MessagesSquare, ScanSearch } from 'lucide-react'
import { i18n } from '@/lib/i18n'
import type { Conversation, Workspace, FloatTab, ReviewLoopInfo } from '../preload'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/Sidebar'
import { ChatView } from '@/components/chat/ChatView'
import { ReviewLoopPickerDialog } from '@/components/chat/ReviewLoopPickerDialog'
import { ReviewLoopSplitView } from '@/components/chat/ReviewLoopSplitView'
import { ConversationBranchChip } from '@/components/ConversationBranchChip'
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
import { SettingsView } from '@/components/SettingsView'
import { OnboardingFlow } from '@/components/OnboardingFlow'
import { AboutModal } from '@/components/AboutModal'
import { useDrawerState } from '@/lib/use-drawer-state'
import { useWorkspaces } from '@/lib/use-workspaces'
import { useMainPanels } from '@/lib/use-main-panels'
import { useAgentStatuses } from '@/lib/use-agent-statuses'
import { usePlans } from '@/lib/use-plans'
import { ProjectSetupDialog } from '@/project-setup/ProjectSetupDialog'
import { useProjectSetup, type ProjectSetupOptions } from '@/project-setup/use-project-setup'
import { useConversationMigration } from '@/lib/use-conversation-migration'
import { ConversationMigrationDialog } from '@/components/conversation-migration/ConversationMigrationDialog'
import { MigrationRecoveryGate } from '@/components/conversation-migration/MigrationRecoveryGate'
import { CHAT_VIEW_COLD_TTL_MS, pruneMountedChatViews } from '@/lib/conversation-mount-lru'
import { useMemoryAutoReclaim } from '@/lib/use-memory-auto-reclaim'

export function DesktopApp() {
  const { t } = useTranslation('ui')
  const [active, setActive] = useState<Conversation | null>(null)
  const [reviewLoops, setReviewLoops] = useState<ReviewLoopInfo[]>([])
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false)
  const [dismissedSplitLoopId, setDismissedSplitLoopId] = useState<string | null>(null)
  const [reviewSplitRatio, setReviewSplitRatio] = useState(50)
  const mainRef = useRef<HTMLElement>(null)

  const [mountedConvs, setMountedConvs] = useState<Conversation[]>([])
  const [unsafeChatIds, setUnsafeChatIds] = useState<ReadonlySet<string>>(new Set())
  const lastVisibleAtRef = useRef<Record<string, number>>({})
  const [hardPressure, setHardPressure] = useState(false)
  const autoReclaimEnabled = useMemoryAutoReclaim()
  const drawer = useDrawerState({ active, mainRef, setMountedConvs })
  const {
    drawerOpen,
    setDrawerOpen,
    drawerTabByConv,
    drawerTab,
    setDrawerTabByConv,
    setActiveDrawerTab,
    setDrawerOpenByConv,
    setMainTabOrderByConv,
    setDrawerWidthByConv,
    setDrawerFullByConv,
    mainTabOrder,
    reorderMainTabs,
    forgetConvDrawerState,
    drawerWidth,
    toggleDrawerFull,
    fullActive,
    dragging,
    chatGptWebEnabled,
    drawerShortcutLabel,
  } = drawer
  const ws = useWorkspaces({ active, setActive, forgetConvDrawerState })
  const {
    workspaces,
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
  const handleConversationExperienceChange = useCallback(
    (conversationId: string, experience: Conversation['experience']) => {
      setActive((current) => (current?.id === conversationId ? { ...current, experience } : current))
      setMountedConvs((current) =>
        current.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, experience } : conversation
        )
      )
      void refreshWorkspaces()
    },
    [refreshWorkspaces]
  )
  const allConversations = useMemo(() => workspaces.flatMap((workspace) => workspace.conversations), [workspaces])
  const pairedLoopForActive = useMemo(
    () =>
      active
        ? (reviewLoops.find(
            (loop) =>
              loop.driver === 'maestrly-pair' &&
              (loop.participants.executor.conversationId === active.id ||
                loop.participants.reviewer?.conversationId === active.id)
          ) ?? null)
        : null,
    [active, reviewLoops]
  )
  const runningReviewLoopForActive = useMemo(
    () =>
      active
        ? (reviewLoops.find(
            (loop) =>
              (loop.participants.executor.conversationId === active.id ||
                loop.participants.reviewer?.conversationId === active.id) &&
              (loop.driver === 'chatgpt-web' ||
                (loop.status !== 'finished' && loop.status !== 'cancelled' && loop.status !== 'interrupted'))
          ) ?? null)
        : null,
    [active, reviewLoops]
  )
  const splitReviewLoop =
    pairedLoopForActive && pairedLoopForActive.loopId !== dismissedSplitLoopId ? pairedLoopForActive : null
  const protectedReviewIds = useMemo(() => {
    const ids = new Set<string>()
    if (splitReviewLoop) {
      ids.add(splitReviewLoop.participants.executor.conversationId)
      if (splitReviewLoop.participants.reviewer) ids.add(splitReviewLoop.participants.reviewer.conversationId)
    }
    return ids
  }, [splitReviewLoop])

  useEffect(() => {
    void window.api.chatReviewLoopStatuses().then(setReviewLoops)
    return window.api.onChatReviewLoopChanged(setReviewLoops)
  }, [])

  // Materialize and pin both existing ChatViews while a paired split is visible.
  useEffect(() => {
    if (!splitReviewLoop) return
    const wanted = new Set([
      splitReviewLoop.participants.executor.conversationId,
      splitReviewLoop.participants.reviewer?.conversationId ?? '',
    ])
    const participants = allConversations.filter((conversation) => wanted.has(conversation.id))
    if (participants.length === 0) return
    setMountedConvs((current) => {
      const byId = new Map(current.map((conversation) => [conversation.id, conversation]))
      for (const conversation of participants) byId.set(conversation.id, conversation)
      return [...byId.values()]
    })
  }, [allConversations, splitReviewLoop])
  const projectSetup = useProjectSetup(reconcileWorkspace)
  const [focusedWorkspaceId, setFocusedWorkspaceId] = useState<string | null>(null)
  const requestProject = useCallback(
    async (options?: ProjectSetupOptions): Promise<Workspace | null> => {
      setFocusedWorkspaceId(null)
      const workspace = await projectSetup.requestProject(options)
      if (workspace) setFocusedWorkspaceId(workspace.id)
      return workspace
    },
    [projectSetup.requestProject]
  )
  const nav = useMainPanels({ workspaces, setActive, refreshWorkspaces })
  const {
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
  } = nav

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
    active &&
    drawerOpen &&
    !mainOverride &&
    !chatGptFloating &&
    visiblePopupTab === null &&
    drawerTabByConv[active.id] === 'chatgpt'
      ? active.id
      : null
  const chatGptPopupVisibleConversationId = active && visiblePopupTab === 'chatgpt' ? active.id : null
  const chatGptVisibleConversationId =
    chatGptPopupVisibleConversationId ??
    chatGptDrawerVisibleConversationId ??
    (chatGptFloatingVisible ? (active?.id ?? null) : null)
  const agents = useAgentStatuses({
    refreshWorkspaces,
    activeId: active?.id ?? null,
    mainOverride,
    chatGptVisibleConversationId,
  })
  const { statuses, attention, acknowledgeConversation } = agents
  useEffect(()=>{
    let mounted=true
    const unsubscribe=window.api.onExecutorOpen(()=>openSettings('platform'))
    void window.api.platformExecutorSettings().then(settings=>{if(mounted&&settings.mode==='team')openSettings('platform')}).catch(()=>{})
    return ()=>{mounted=false;unsubscribe()}
  },[openSettings])

  const handleSidebarConversationSelect = useCallback(
    (conv: Conversation) => {
      acknowledgeConversation(conv.id)
      if (
        reviewLoops.some(
          (loop) =>
            loop.driver === 'maestrly-pair' &&
            (loop.participants.executor.conversationId === conv.id ||
              loop.participants.reviewer?.conversationId === conv.id)
        )
      ) {
        setDismissedSplitLoopId(null)
      }
      handleSelect(conv)
    },
    [acknowledgeConversation, handleSelect, reviewLoops]
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
  const plan = usePlans({ setDrawerTabByConv, setDrawerOpenByConv })
  const { plans, pendingPlanIds } = plan
  const [dialogWs, setDialogWs] = useState<string | null>(null)

  const [branchDialogWs, setBranchDialogWs] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const [openTargets, setOpenTargets] = useState<{ vscode: boolean }>({ vscode: false })
  const migration = useConversationMigration({
    active,
    refreshWorkspaces,
    focusConversation: handleSelect,
  })
  useEffect(() => {
    window.api.getOpenTargets().then((t) => setOpenTargets({ vscode: t.vscode }))
  }, [])

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
        protectedIds: protectedReviewIds,
      })
    )
  }, [active?.id, autoReclaimEnabled, hardPressure, protectedReviewIds, statuses, mountedConvs.length, unsafeChatIds])

  useEffect(() => {
    if (autoReclaimEnabled !== true) return
    const timer = window.setInterval(
      () => {
        setMountedConvs((prev) =>
          pruneMountedChatViews(prev, statuses, active?.id ?? null, unsafeChatIds, undefined, undefined, {
            autoReclaimEnabled,
            lastVisibleAt: lastVisibleAtRef.current,
            hardPressure,
            protectedIds: protectedReviewIds,
          })
        )
      },
      Math.min(30_000, CHAT_VIEW_COLD_TTL_MS)
    )
    return () => window.clearInterval(timer)
  }, [active?.id, autoReclaimEnabled, hardPressure, protectedReviewIds, statuses, unsafeChatIds])

  useEffect(() => {
    const live = new Set(workspaces.flatMap((w) => w.conversations).map((c) => c.id))
    setMountedConvs((prev) => (prev.some((c) => !live.has(c.id)) ? prev.filter((c) => live.has(c.id)) : prev))
    const pruneDead = <T,>(prev: Record<string, T>): Record<string, T> => {
      const dead = Object.keys(prev).filter((id) => !live.has(id))
      if (dead.length === 0) return prev
      const next = { ...prev }
      for (const id of dead) delete next[id]
      return next
    }
    setDrawerOpenByConv(pruneDead)
    setDrawerTabByConv(pruneDead)
    setDrawerWidthByConv(pruneDead)
    setDrawerFullByConv(pruneDead)

    setMainTabOrderByConv((prev) => {
      let next = prev
      for (const conv of workspaces.flatMap((w) => w.conversations)) {
        if (next[conv.id]) continue
        const saved = conv.uiPrefs?.mainTabOrder
        if (saved?.length) {
          if (next === prev) next = { ...prev }
          next[conv.id] = sanitizeMainOrder(saved, conv)
        }
      }
      return pruneDead(next)
    })
  }, [workspaces])

  useEffect(() => {
    const root = document.documentElement
    const os = window.api.platformInfo.os
    root.classList.toggle('is-windows', os === 'win')
    root.classList.toggle('is-linux', os === 'linux')
    root.classList.toggle('is-mac', os === 'mac')
  }, [])

  useEffect(
    () => window.api.onWindowFullscreen((full) => document.documentElement.classList.toggle('is-fullscreen', full)),
    []
  )

  useEffect(() => {
    window.api.setVisibleConversation(mainOverride ? null : (active?.id ?? null))
  }, [active?.id, mainOverride])

  // Example: window.__sendToActive('\x1b[I')  |  window.__sendToActive('\x1b[200~hello\x1b[201~\r')
  useEffect(() => {
    ;(window as unknown as { __sendToActive?: (d: string) => void }).__sendToActive = (d) =>
      active && window.api.writePty(active.id, d)
  }, [active])

  const [aboutOpen, setAboutOpen] = useState(false)

  const overlaysSuspendNativeViews =
    dialogWs !== null ||
    projectSetup.state.open ||
    aboutOpen ||
    migration.dialog.open ||
    migration.recoveriesChecking ||
    migration.blockingRecoveries.length > 0 ||
    migration.recoveryError !== null
  useEffect(() => {
    window.api.popupSetSuppressed(overlaysSuspendNativeViews)
  }, [overlaysSuspendNativeViews])

  const handleNewSiblingConversation = useCallback(
    async (sourceConvId: string) => {
      try {
        const conv = await window.api.createSiblingConversation({ sourceConversationId: sourceConvId })
        await refreshWorkspaces()
        handleSelect(conv)
      } catch (e: any) {
        const error = String(e?.message ?? e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
        alert(i18n.t('ui:app.alertNewSibling', { error }))
      }
    },
    [refreshWorkspaces, handleSelect]
  )

  const handleReviewLoopStarted = useCallback(
    (loop: ReviewLoopInfo) => {
      setReviewLoops((current) => [loop, ...current.filter((item) => item.loopId !== loop.loopId)])
      setDismissedSplitLoopId(null)
      const ids = new Set([loop.participants.executor.conversationId, loop.participants.reviewer?.conversationId ?? ''])
      setMountedConvs((current) => {
        const byId = new Map(current.map((conversation) => [conversation.id, conversation]))
        for (const conversation of allConversations)
          if (ids.has(conversation.id)) byId.set(conversation.id, conversation)
        return [...byId.values()]
      })
      const executor = allConversations.find(
        (conversation) => conversation.id === loop.participants.executor.conversationId
      )
      if (executor) handleSelect(executor)
    },
    [allConversations, handleSelect]
  )

  const handleReviewerCreated = useCallback(
    async (conversation: Conversation) => {
      setMountedConvs((current) => {
        const index = current.findIndex((item) => item.id === conversation.id)
        return index < 0
          ? [...current, conversation]
          : current.map((item, itemIndex) => (itemIndex === index ? conversation : item))
      })
      await refreshWorkspaces()
    },
    [refreshWorkspaces]
  )

  const focusReviewPane = useCallback(
    (conversationId: string) => {
      const conversation = allConversations.find((item) => item.id === conversationId)
      if (conversation) handleSelect(conversation)
    },
    [allConversations, handleSelect]
  )

  return (
    <SettingsProvider openSettings={openSettings}>
      <OnboardingProvider isOpen={onboardingOpen} openOnboarding={openOnboarding}>
        <div className="relative flex h-full bg-background text-foreground">
          {sidebarOpen && (
            <Sidebar
              workspaces={workspaces}
              statuses={statuses}
              attention={attention}
              activeId={active?.id ?? null}
              focusedWorkspaceId={focusedWorkspaceId}
              pendingPlanIds={pendingPlanIds}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived((v) => !v)}
              onSelect={handleSidebarConversationSelect}
              onAddWorkspace={() => void requestProject()}
              onRemoveWorkspace={handleRemoveWorkspace}
              onNewConversation={(wsId) => setDialogWs(wsId)}
              onOpenProjectNotes={(wsId) => {
                setProjectNotesWs(wsId)
                setProjectMemoryWs(null)
                setSettingsOpen(false)
                setOnboardingOpen(false)
              }}
              onOpenProjectMemory={(wsId) => {
                setProjectMemoryWs(wsId)
                setProjectNotesWs(null)
                setSettingsOpen(false)
                setOnboardingOpen(false)
              }}
              onEditDefaultBranch={(wsId) => setBranchDialogWs(wsId)}
              onOpenAbout={() => setAboutOpen(true)}
              onRenameConversation={handleRename}
              onArchiveConversation={handleArchive}
              onPinConversation={handlePinConversation}
              onDeleteConversation={handleDelete}
              onMigrateConversation={migration.openMigration}
              onNewSiblingConversation={handleNewSiblingConversation}
              onArchiveSiblings={handleArchiveSiblings}
              onDeleteSiblings={handleDeleteSiblings}
              onReorderWorkspaces={handleReorderWorkspaces}
              onReorderConversations={handleReorderConversations}
              groups={groups}
              onCreateGroup={handleCreateGroup}
              onRenameGroup={handleRenameGroup}
              onDeleteGroup={handleDeleteGroup}
              onReorderGroups={handleReorderGroups}
              onToggleGroupCollapsed={handleToggleGroupCollapsed}
              onMoveWorkspaceToGroup={handleMoveWorkspaceToGroup}
              onToggleWorkspaceCollapsed={handleToggleWorkspaceCollapsed}
              onCollapseSidebar={() => setSidebarOpen(false)}
              openTargets={openTargets}
              onOpenExternal={(scope, id, target) =>
                void window.api.openExternal(scope, id, target).then((r) => {
                  if (!r.ok) console.error('[open-external]', target, r.error)
                })
              }
            />
          )}

          <main
            ref={mainRef}
            className="flex min-w-0 flex-1 flex-col"
            style={fullActive && !mainOverride ? { display: 'none' } : undefined}
          >
            {projectNotesWs && (
              <ProjectNotesView
                workspaceId={projectNotesWs}
                workspaceName={workspaces.find((w) => w.id === projectNotesWs)?.name ?? ''}
                onShowSidebar={sidebarOpen ? undefined : () => setSidebarOpen(true)}
                onClose={() => setProjectNotesWs(null)}
              />
            )}
            {projectMemoryWs && (
              <ProjectMemoryView
                workspaceId={projectMemoryWs}
                workspaceName={workspaces.find((w) => w.id === projectMemoryWs)?.name ?? ''}
                onShowSidebar={sidebarOpen ? undefined : () => setSidebarOpen(true)}
                onClose={() => setProjectMemoryWs(null)}
              />
            )}
            {settingsOpen && (
              <SettingsView
                initialSection={settingsSection}
                onShowSidebar={sidebarOpen ? undefined : () => setSidebarOpen(true)}
                onClose={() => setSettingsOpen(false)}
              />
            )}
            {onboardingOpen && (
              <OnboardingFlow
                workspaces={workspaces}
                onAddWorkspace={requestProject}
                onCreateConversation={(wsId) => setDialogWs(wsId)}
                onClose={completeOnboarding}
              />
            )}

            <div className="flex min-h-0 flex-1 flex-col" style={mainOverride ? { display: 'none' } : undefined}>
              <header
                className={cn(
                  'drag flex h-10 shrink-0 items-center justify-between gap-2 hairline-b pr-2',
                  sidebarOpen ? 'pl-3' : 'pl-[var(--tt-offset)]'
                )}
              >
                <div className="no-drag flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  {!sidebarOpen && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => setSidebarOpen(true)}
                      title={t('common.showWorkspaces')}
                    >
                      <PanelLeft className="size-4" />
                    </Button>
                  )}
                  <span className="truncate text-[13px] font-medium text-foreground/90">{active?.name ?? ''}</span>
                  {active && <ConversationBranchChip conversationId={active.id} status={statuses[active.id]} />}
                </div>
                <div className="no-drag flex min-w-0 items-center gap-2">
                  {active &&
                    active.archived === 0 &&
                    !active.isMulti &&
                    !runningReviewLoopForActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 min-w-0 gap-1.5 px-2 text-[11px]"
                        onClick={() => setReviewPickerOpen(true)}
                        title={t('reviewLoop.openPicker', { ns: 'chat' })}
                      >
                        <ScanSearch className="size-3.5" />
                        <span className="truncate">{t('reviewLoop.openPicker', { ns: 'chat' })}</span>
                      </Button>
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
                {splitReviewLoop && splitReviewLoop.participants.reviewer && (
                  <ReviewLoopSplitView
                    loop={splitReviewLoop}
                    ratio={reviewSplitRatio}
                    onRatioChange={setReviewSplitRatio}
                    onFocus={focusReviewPane}
                    onDismiss={() => setDismissedSplitLoopId(splitReviewLoop.loopId)}
                  />
                )}

                {mountedConvs.map((c) => {
                  const splitRole = splitReviewLoop
                    ? splitReviewLoop.participants.executor.conversationId === c.id
                      ? 'executor'
                      : splitReviewLoop.participants.reviewer?.conversationId === c.id
                        ? 'reviewer'
                        : null
                    : null
                  const style: CSSProperties = splitReviewLoop
                    ? splitRole === 'executor'
                      ? { top: 28, bottom: 0, left: 0, right: `${100 - reviewSplitRatio}%` }
                      : splitRole === 'reviewer'
                        ? { top: 28, bottom: 0, left: `${reviewSplitRatio}%`, right: 0 }
                        : { display: 'none' }
                    : { display: active?.id === c.id ? undefined : 'none' }
                  return (
                    // Inactive conversations use display:none; terminal views must refit when shown.

                    <div
                      key={c.id}
                      className="absolute inset-0"
                      style={style}
                      data-review-loop-pane={splitRole ?? undefined}
                      onMouseDownCapture={() => {
                        if (splitRole && active?.id !== c.id) focusReviewPane(c.id)
                      }}
                    >
                      <ChatView
                        key={c.id}
                        conversationId={c.id}
                        cwd={c.cwd}
                        experience={c.experience}
                        onExperienceChange={handleConversationExperienceChange}
                        visible={(splitRole !== null || active?.id === c.id) && !mainOverride}
                        status={statuses[c.id] ?? c.status}
                        onEvictionSafetyChange={onChatEvictionSafetyChange}
                      />
                    </div>
                  )
                })}
                {!active && onboardingChecked && (
                  <div className="flex h-full flex-col items-center justify-center gap-3.5 text-muted-foreground">
                    <div className="flex size-14 items-center justify-center rounded-2xl bg-white/[0.04] ring-1 ring-white/[0.06]">
                      <MessagesSquare className="size-7 opacity-60" />
                    </div>
                    <p className="text-sm">{t('app.emptyState')}</p>
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
                <Drawer
                  activeConv={active}
                  visible={drawerOpen && !mainOverride}
                  suspended={overlaysSuspendNativeViews}
                  onClose={() => setDrawerOpen(false)}
                  isFull={fullActive}
                  onToggleFull={toggleDrawerFull}
                  activePlan={plans[active.id] ?? null}
                  tab={drawerTab}
                  onTabChange={setActiveDrawerTab}
                  mainTabOrder={mainTabOrder}
                  onReorderMainTabs={reorderMainTabs}
                  chatGptWebEnabled={chatGptWebEnabled}
                />
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

          <NewConversationDialog
            workspaceId={dialogWs}
            workspaces={workspaces}
            requestProject={requestProject}
            open={dialogWs !== null}
            onOpenChange={(o) => !o && setDialogWs(null)}
            onCreated={handleCreated}
          />

          <ReviewLoopPickerDialog
            executor={active}
            open={reviewPickerOpen}
            onOpenChange={setReviewPickerOpen}
            onStarted={handleReviewLoopStarted}
            onReviewerCreated={handleReviewerCreated}
          />

          <ProjectSetupDialog
            state={projectSetup.state}
            onModeChange={projectSetup.setMode}
            onStart={projectSetup.start}
            onResolveEmptyRemote={projectSetup.resolveEmptyRemote}
            onClose={projectSetup.close}
          />

          <WorkspaceDefaultBranchDialog
            workspaceId={branchDialogWs}
            workspaceName={workspaces.find((w) => w.id === branchDialogWs)?.name}
            currentDefault={workspaces.find((w) => w.id === branchDialogWs)?.defaultBranch ?? ''}
            open={branchDialogWs !== null}
            onOpenChange={(o) => !o && setBranchDialogWs(null)}
            onSaved={() => void refreshWorkspaces()}
          />

          <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

          <MigrationRecoveryGate
            checking={migration.recoveriesChecking}
            recoveries={migration.blockingRecoveries}
            error={migration.recoveryError}
            resolving={migration.resolvingRecovery}
            onResolve={(recovery, action) => void migration.resolveRecovery(recovery, action)}
            onRetry={() => void migration.retryRecoveries()}
          />

          <PopupOverlay convId={mainOverride ? null : (active?.id ?? null)} />
        </div>
      </OnboardingProvider>
    </SettingsProvider>
  )
}
