import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Repeat, X } from 'lucide-react'
import {
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  FLEET_PEER_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  type FleetBot,
  type FleetRoutineRun,
} from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
import { environmentOf } from '@/lib/fleet/selectors'
import { hasEnvironments } from '@/lib/fleet/environments'
import { botComputerMode } from '@/lib/fleet/provisioning'
import { fleetErrorText } from '@/lib/fleet/errors'
import { useBotWorkspaceLayout } from '@/lib/fleet/use-bot-workspace-layout'
import { ChatWindowHost } from '@/components/chat/ChatWindowHost'
import type { EnvironmentSettingsSection } from './environment-settings/sections'
import { BotChatHeader, type BotConversationPane } from './BotChatHeader'
import { RoutineRunsView } from './RoutineRunsView'
import { PeerThreadsView } from './PeerThreadsView'
import { emptyRuns, emptyThreads } from '@/lib/fleet/state'
import { readSeenThreads, threadSeenKey, unseenThreads, writeSeenThreads } from '@/lib/fleet/threads'
import {
  readSeenRuns,
  runAlerts,
  runMarkers,
  runSeenKey,
  runSettingsOf,
  runTitle,
  unseenRuns,
  writeSeenRuns,
} from '@/lib/fleet/runs'
import { BotConversation } from './BotConversation'
import { BotFilesDrawer } from './BotFilesDrawer'
import type { BotPane } from './BotPaneSwitch'
import { BotScreen } from './BotScreen'
import type { SettingsLeaveGuard } from './BotSettings'
import { BotSettingsSheet } from './BotSettingsSheet'
import { BotWorkspace } from './BotWorkspace'
import { BotFilesRemovedProvider } from './bot-files-context'
import { freshestUsage, highlightFileNode, type FilesConversation, type FileSort } from '@/lib/fleet/files'
import { useBotFiles } from '@/lib/fleet/use-bot-files'

type BotViewProps = {
  bot: FleetBot
  view: Extract<FleetView, { kind: 'bot' }>
  fleet: FleetController
  onView: (view: FleetView) => void
  onOpenBot: (id: string) => void
  onDetachedChange?: (detached: boolean) => void
  /**
   * Whether the bot is the one on screen. A bot whose conversation is in a window of its own stays mounted while
   * another bot is shown; its computer then stops streaming.
   */
  active?: boolean
}

export function BotView(props: BotViewProps) {
  return <BotViewContent key={JSON.stringify([props.fleet.state.connection.url, props.bot.id])} {...props} />
}

/**
 * A bot at work: its conversation beside its computer, each under its own header. The `screen` destination opens the
 * computer, `settings` opens the settings panel over both, and `conversation` only closes that panel. The
 * conversation can move to a window of its own; the computer stays here.
 */
function BotViewContent({ bot, view, fleet, onView, onOpenBot, onDetachedChange, active = true }: BotViewProps) {
  const { t } = useTranslation('fleet')
  const layout = useBotWorkspaceLayout(fleet.state.connection.url, bot.id, view.tab === 'screen' ? 'split' : 'chat')
  const settingsOpen = active && view.tab === 'settings'
  const [giveBackRequest, setGiveBackRequest] = useState(0)
  const [detached, setDetached] = useState(false)
  const handleDetachedChange = useCallback(
    (value: boolean) => {
      setDetached(value)
      onDetachedChange?.(value)
    },
    [onDetachedChange]
  )
  const { openComputer, closeComputer, showPane } = layout
  useEffect(() => {
    // Existing destinations (including help requests) still reveal the computer.
    if (active && view.tab === 'screen') openComputer()
  }, [active, view.tab, openComputer])

  // --- Routine runs in conversations of their own (`routine-conversations`). ---
  const runsSupported =
    fleet.state.connection.features.includes(FLEET_ROUTINE_CONVERSATIONS_FEATURE) &&
    bot.capabilities.includes(FLEET_ROUTINE_CONVERSATIONS_FEATURE)
  const [pane, setPane] = useState<BotConversationPane>(view.tab === 'runs' ? 'runs' : 'conversation')
  const [runId, setRunId] = useState<string | null>(view.runId ?? null)
  useEffect(() => {
    if (view.tab !== 'runs') return
    setPane('runs')
    if (view.runId) setRunId(view.runId)
  }, [view.tab, view.runId])
  // --- Conversations with other bots, each in a conversation of its own (`peer-conversations`). ---
  const threadsSupported =
    fleet.state.connection.features.includes(FLEET_PEER_CONVERSATIONS_FEATURE) &&
    bot.capabilities.includes(FLEET_PEER_CONVERSATIONS_FEATURE)
  const [threadId, setThreadId] = useState<string | null>(null)
  const shownPane: BotConversationPane =
    (pane === 'runs' && runsSupported) || (pane === 'threads' && threadsSupported) ? pane : 'conversation'
  const { ensureRuns, ensureThreads } = fleet
  useEffect(() => {
    if (threadsSupported) ensureThreads(bot.id)
  }, [bot.id, ensureThreads, threadsSupported])
  const threads = (fleet.state.threads[bot.id] ?? emptyThreads).threads
  const threadsLoaded = !!fleet.state.threads[bot.id]?.loaded
  // What the owner has seen of each thread, kept on this computer: activity after that, and a pause, count as new.
  const threadSeenStorage = threadSeenKey(fleet.state.connection.url, bot.id)
  const [seenThreads, setSeenThreads] = useState<Map<string, string> | null>(null)
  useEffect(() => {
    setSeenThreads(null)
  }, [threadSeenStorage])
  useEffect(() => {
    if (threadsLoaded && !seenThreads) setSeenThreads(readSeenThreads(threadSeenStorage, threads))
  }, [seenThreads, threadSeenStorage, threads, threadsLoaded])
  const showingThread = active && shownPane === 'threads' ? threads.find((thread) => thread.id === threadId) : undefined
  useEffect(() => {
    if (!seenThreads || !showingThread || seenThreads.get(showingThread.id) === showingThread.lastActivityAt) return
    const next = new Map(seenThreads).set(showingThread.id, showingThread.lastActivityAt)
    writeSeenThreads(threadSeenStorage, next)
    setSeenThreads(next)
  }, [seenThreads, showingThread, threadSeenStorage])
  const unseenThreadIds = useMemo(
    () => new Set(seenThreads ? unseenThreads(threads, seenThreads).map((thread) => thread.id) : []),
    [seenThreads, threads]
  )
  const openThread = useCallback((id: string | null) => {
    setPane('threads')
    setThreadId(id)
  }, [])
  useEffect(() => {
    if (runsSupported) ensureRuns(bot.id)
  }, [bot.id, ensureRuns, runsSupported])
  const runs = (fleet.state.runs[bot.id] ?? emptyRuns).runs
  const runSettings = runSettingsOf(bot)
  const markers = useMemo(
    () => (runsSupported ? runMarkers(runs, runSettings) : []),
    [runSettings, runs, runsSupported]
  )
  const [citation, setCitation] = useState<FleetRoutineRun | null>(null)
  // The runs the owner opened, kept on this computer: the others that ended with something new count as new.
  const seenKey = runSeenKey(fleet.state.connection.url, bot.id)
  const runsLoaded = !!fleet.state.runs[bot.id]?.loaded
  const [seen, setSeen] = useState<Set<string> | null>(null)
  useEffect(() => {
    setSeen(null)
  }, [seenKey])
  useEffect(() => {
    if (runsLoaded && !seen) setSeen(readSeenRuns(seenKey, runs))
  }, [runs, runsLoaded, seen, seenKey])
  const showingRun = active && shownPane === 'runs' ? runId : null
  useEffect(() => {
    if (!seen || !showingRun || seen.has(showingRun)) return
    const next = new Set(seen).add(showingRun)
    writeSeenRuns(seenKey, next)
    setSeen(next)
  }, [seen, seenKey, showingRun])
  const unseen = seen ? unseenRuns(runs, seen, bot).length : 0
  const openRun = useCallback((id: string | null) => {
    setPane('runs')
    setRunId(id)
  }, [])
  // A run that ends tells the owner, unless they are looking at it, as the bot's settings say.
  const [notices, setNotices] = useState<FleetRoutineRun[]>([])
  const statuses = useRef<Map<string, FleetRoutineRun['status']> | null>(null)
  useEffect(() => {
    if (!runsLoaded) return
    const previous = statuses.current
    statuses.current = new Map(runs.map((run) => [run.id, run.status]))
    if (!previous) return
    const ended = runs.filter(
      (run) =>
        (previous.get(run.id) === 'delivered' || previous.get(run.id) === 'unknown') &&
        (run.status === 'completed' || run.status === 'failed') &&
        run.conversation !== 'primary' &&
        runAlerts(run, runSettings) &&
        run.id !== showingRun
    )
    // A bot shown elsewhere (its conversation in a window of its own) tells only through its badge.
    if (ended.length && active)
      setNotices((list) => [...ended, ...list.filter((item) => !ended.some((run) => run.id === item.id))].slice(0, 3))
  }, [active, runSettings, runs, runsLoaded, showingRun])
  useEffect(() => {
    if (!notices.length) return
    const timer = setTimeout(() => setNotices((list) => list.slice(0, -1)), 9_000)
    return () => clearTimeout(timer)
  }, [notices])
  const environment = hasEnvironments(fleet.state.connection)
    ? environmentOf(fleet.state.snapshot.environments, bot)
    : undefined
  // Settings with unsaved changes ask before this view leaves them.
  const leaveGuard = useRef<SettingsLeaveGuard | null>(null)
  const go = (next: FleetView) => {
    // From the conversation's own window, a destination in the main window brings that window forward.
    if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
    const guard = settingsOpen ? leaveGuard.current : null
    if (guard) guard(() => onView(next))
    else onView(next)
  }
  const botView = (tab: 'conversation' | 'screen' | 'settings'): FleetView => ({ kind: 'bot', botId: bot.id, tab })
  const showComputer = () => {
    if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
    openComputer()
    onView(botView('screen'))
  }
  const hideComputer = () => {
    closeComputer()
    onView(botView('conversation'))
  }
  const openSettings = () => {
    if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
    onView(botView('settings'))
  }
  const environmentSettings =
    !!environment &&
    fleet.state.connection.features.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE) &&
    environment.capabilities.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
  const openEnvironment = (next: 'overview' | 'screen' | 'settings', section?: EnvironmentSettingsSection) =>
    environment && go({ kind: 'environment', environmentId: environment.id, tab: next, section })
  const onShowPane = (pane: BotPane) => (pane === 'computer' ? showComputer() : showPane('chat'))
  const activePane: BotPane = layout.showChat ? 'chat' : 'computer'
  const botFiles = useBotFiles(fleet, bot, active)
  const [filesOpen, setFilesOpen] = useState(false)
  const [filesRequest, setFilesRequest] = useState<{ sort?: FileSort; nonce: number } | null>(null)
  const [revealFile, setRevealFile] = useState<{ id: string; nonce: number } | null>(null)
  const [revealMissed, setRevealMissed] = useState(0)
  const filesUsage = freshestUsage(botFiles.list?.usage, bot.sharedFiles)
  const chatBodyRef = useRef<HTMLDivElement>(null)
  const filesButtonRef = useRef<HTMLButtonElement>(null)
  /** Closing forgets what the drawer was opened for; a dismissal gives the focus back to the Files button. */
  const closeFiles = useCallback((restoreFocus: boolean) => {
    setFilesOpen(false)
    setFilesRequest(null)
    if (restoreFocus) requestAnimationFrame(() => filesButtonRef.current?.focus())
  }, [])
  const currentConversation = useMemo<FilesConversation | null>(() => {
    if (shownPane === 'conversation') return { kind: 'primary' }
    if (shownPane === 'runs') return runId ? { kind: 'routine', runId } : null
    return threadId ? { kind: 'thread', threadId } : null
  }, [runId, shownPane, threadId])
  // A file to show is shown once: the conversation that finds it, or says it cannot, clears it.
  const handleRevealed = useCallback((found: boolean) => {
    setRevealFile(null)
    if (!found) setRevealMissed((n) => n + 1)
  }, [])
  useEffect(() => {
    if (!revealFile || shownPane === 'conversation') return
    const card = chatBodyRef.current?.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(revealFile.id)}"]`)
    if (card) highlightFileNode(card)
    handleRevealed(!!card)
  }, [handleRevealed, revealFile, shownPane])
  return (
    <BotFilesRemovedProvider value={botFiles.removedAt}>
      <div data-bot-view className="flex min-h-0 min-w-0 flex-1 flex-col bg-chat-canvas">
        {fleet.actionError &&
          (fleet.actionError.botId === bot.id ||
            (bot.environmentId !== null && fleet.actionError.environmentId === bot.environmentId)) && (
            <p role="alert" className="px-5 py-2 text-xs text-destructive">
              {fleetErrorText(fleet.actionError.message, t)}
            </p>
          )}
        <BotWorkspace
          botId={bot.id}
          name={bot.name}
          layout={layout}
          conversation={
            <>
              <BotChatHeader
                bot={bot}
                fleet={fleet}
                environment={environment}
                narrow={layout.narrow}
                activePane={activePane}
                computerOpen={layout.mode !== 'chat'}
                onShowPane={onShowPane}
                onOpenComputer={showComputer}
                onOpenSettings={openSettings}
                onOpenServer={() => go({ kind: 'server' })}
                onOpenEnvironment={environment ? () => openEnvironment('overview') : undefined}
                files={
                  botFiles.supported
                    ? {
                        usage: filesUsage,
                        open: filesOpen,
                        buttonRef: filesButtonRef,
                        onToggle: () => (filesOpen ? closeFiles(false) : setFilesOpen(true)),
                      }
                    : undefined
                }
                panes={
                  runsSupported || threadsSupported
                    ? {
                        pane: shownPane,
                        runs: runsSupported,
                        threads: threadsSupported,
                        unseenRuns: unseen,
                        unseenThreads: unseenThreadIds.size,
                        onPane: (next) => {
                          setPane(next)
                          if (next === 'conversation' && view.tab === 'runs') onView(botView('conversation'))
                        },
                        onOpenRun: (id) => openRun(id),
                        onOpenThread: (id) => openThread(id),
                      }
                    : undefined
                }
              />
              <ChatWindowHost
                target={{ kind: 'bot', serverId: fleet.serverId, id: bot.id }}
                title={bot.name}
                onDetachedChange={handleDetachedChange}
                onReattach={() => go(botView('conversation'))}
              >
                {(inWindow) => (
                  <div ref={chatBodyRef} className="relative flex min-h-0 min-w-0 flex-1">
                    {shownPane === 'threads' ? (
                      <PeerThreadsView
                        bot={bot}
                        fleet={fleet}
                        selectedThreadId={threadId}
                        unseen={unseenThreadIds}
                        onSelect={setThreadId}
                        visible={inWindow || (active && layout.showChat)}
                        onOpenBot={onOpenBot}
                        onOpenScreen={showComputer}
                        onOpenMain={() => setPane('conversation')}
                      />
                    ) : shownPane === 'runs' ? (
                      <RoutineRunsView
                        bot={bot}
                        fleet={fleet}
                        selectedRunId={runId}
                        seen={seen}
                        onSelect={setRunId}
                        visible={inWindow || (active && layout.showChat)}
                        onCite={(run) => {
                          setCitation(run)
                          setPane('conversation')
                        }}
                        onOpenBot={onOpenBot}
                        onOpenScreen={showComputer}
                      />
                    ) : (
                      <BotConversation
                        bot={bot}
                        fleet={fleet}
                        runMarkers={markers}
                        onOpenRun={runsSupported ? (id) => openRun(id) : undefined}
                        onOpenThread={threadsSupported ? (id) => openThread(id) : undefined}
                        citation={citation}
                        onClearCitation={() => setCitation(null)}
                        visible={inWindow || (active && layout.showChat)}
                        onOpenFiles={
                          botFiles.supported
                            ? () => {
                                setFilesOpen(true)
                                setFilesRequest((prev) => ({ sort: 'size', nonce: (prev?.nonce ?? 0) + 1 }))
                              }
                            : undefined
                        }
                        filesUsage={filesUsage}
                        revealFile={revealFile}
                        onRevealed={handleRevealed}
                        onOpenBot={(id) => {
                          onOpenBot(id)
                          if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
                        }}
                        onOpenScreen={showComputer}
                        onOpenSettings={openSettings}
                        onOpenEnvironmentScreen={environment ? () => openEnvironment('screen') : undefined}
                        onOpenEnvironmentSettings={
                          environmentSettings
                            ? (target) => openEnvironment('settings', target === 'mcp' ? 'tools' : 'skills')
                            : undefined
                        }
                        onGiveBack={() => {
                          if (detached) void window.api.chatWindowShowSource(`bot:${bot.id}`)
                          setGiveBackRequest((value) => value + 1)
                        }}
                      />
                    )}
                    {filesOpen && botFiles.supported && (
                      <BotFilesDrawer
                        bot={bot}
                        files={botFiles}
                        conversation={currentConversation}
                        request={filesRequest}
                        onClose={closeFiles}
                        onReveal={(file) => {
                          if (file.origin.kind === 'primary' && shownPane !== 'conversation') {
                            setPane('conversation')
                            if (view.tab === 'runs') onView(botView('conversation'))
                          }
                          setRevealFile((prev) => ({ id: file.id, nonce: (prev?.nonce ?? 0) + 1 }))
                        }}
                        onOpenLane={(origin) => {
                          if (origin.kind === 'routine') openRun(origin.runId)
                          else openThread(origin.threadId)
                        }}
                        revealMissed={revealMissed}
                      />
                    )}
                  </div>
                )}
              </ChatWindowHost>
            </>
          }
          computer={
            layout.computerOpened ? (
              <BotScreen
                bot={bot}
                fleet={fleet}
                mode={botComputerMode(bot, environment)}
                layoutMode={layout.mode}
                narrow={layout.narrow}
                activePane={activePane}
                giveBackRequest={giveBackRequest}
                streaming={active && layout.mode !== 'chat'}
                // The panel covers the computer: it keeps streaming, but takes no input meanwhile.
                visible={active && layout.showComputer && !settingsOpen}
                onReveal={openComputer}
                onShowPane={onShowPane}
                onMaximize={layout.maximize}
                onRestore={layout.restore}
                onClose={hideComputer}
                onOpenSettings={openSettings}
                onOpenEnvironment={environment ? () => openEnvironment('overview') : undefined}
                onOpenEnvironmentScreen={environment ? () => openEnvironment('screen') : undefined}
              />
            ) : null
          }
        />
        {active && notices.length > 0 && (
          <div
            aria-live="polite"
            className="pointer-events-none fixed right-4 top-[60px] z-40 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
          >
            {notices.map((run) => {
              const failed = run.status === 'failed'
              const title = runTitle(run, t('transcript.routine.label'))
              return (
                <div
                  key={run.id}
                  role="status"
                  className="pointer-events-auto flex gap-2.5 rounded-xl border border-border-strong bg-popover p-3 text-[13px] shadow-2xl"
                >
                  <span
                    aria-hidden="true"
                    className={`flex size-[26px] shrink-0 items-center justify-center rounded-lg ${failed ? 'bg-red-400/10 text-red-300' : 'bg-sky-400/10 text-sky-300'}`}
                  >
                    {failed ? <AlertTriangle className="size-3.5" /> : <Repeat className="size-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {t(failed ? 'runs.notice.failed' : 'runs.notice.finished', { title })}
                    </p>
                    {(run.report?.summary || run.finalText) && (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {run.report?.summary ?? run.finalText}
                      </p>
                    )}
                    <button
                      type="button"
                      className="mt-2 rounded-md border border-border-strong px-2.5 py-1 text-xs hover:bg-white/[0.05]"
                      onClick={() => {
                        setNotices((list) => list.filter((item) => item.id !== run.id))
                        openRun(run.id)
                        onView(botView('conversation'))
                      }}
                    >
                      {t('runs.notice.open')}
                    </button>
                  </div>
                  <button
                    type="button"
                    aria-label={t('runs.notice.dismiss')}
                    className="self-start rounded-md p-1 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                    onClick={() => setNotices((list) => list.filter((item) => item.id !== run.id))}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {settingsOpen && (
          <BotSettingsSheet
            bot={bot}
            fleet={fleet}
            leaveGuard={leaveGuard}
            onClose={() => onView(botView('conversation'))}
            // The destination opens the computer once the panel has been left (or its changes dealt with).
            onOpenScreen={() => go(botView('screen'))}
            onOpenEnvironment={
              environment ? () => openEnvironment(environmentSettings ? 'settings' : 'overview') : undefined
            }
            onArchived={() => onView({ kind: 'server' })}
          />
        )}
      </div>
    </BotFilesRemovedProvider>
  )
}
