import { AccountsPage } from './features/accounts/AccountsPage'
import { EnvironmentsPage } from './features/environments/EnvironmentsPage'
import { Plus, Settings2, Monitor, UserRound } from 'lucide-react'
import { Button } from './ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatUiProvider, type ChatUiContextValue } from '@maestrly/chat-ui'
import { chatUiLabels } from './i18n/chatUiLabels'
import type { Bot } from '@maestrly/host-protocol'
import type { Connection, HostTarget, OnboardingDraft, UiPreferences } from '../shared/types'
import { LocaleContext, useT } from './i18n'
import { applyTheme } from './theme'
import { FirstBot } from './features/onboarding/FirstBot'
import { BotChat, createChatState, type ChatState } from './features/chat/BotChat'
import { BotDetails } from './features/bots/BotDetails'
import { Settings } from './features/settings/Settings'
import { ComputersPage } from './features/computers/ComputersPage'
import { BotDesktopPanel } from './features/desktop/BotDesktopPanel'
import { TeamsList } from './features/teams/TeamsList'
import { CreateTeam } from './features/teams/CreateTeam'
import { TeamChat, createTeamChatState, type TeamChatState } from './features/teams/TeamChat'
import { TeamDetails } from './features/teams/TeamDetails'
import type { Team, TeamDetails as TeamDetailsShape } from '@maestrly/host-protocol'
import './style.css'
type View = 'onboarding' | 'chat' | 'settings' | 'computers' | 'accounts' | 'environments' | 'team' | 'team-create'
export function App() {
  const [preferences, setPreferences] = useState<UiPreferences>({ theme: 'system', locale: 'pt-BR', advanced: false })
  const chatUi = useMemo<ChatUiContextValue>(
    () => ({
      labels: chatUiLabels(preferences.locale),
      openExternal: (url) => void window.bot.openExternal(url),
      locale: preferences.locale,
    }),
    [preferences.locale]
  )
  return (
    <LocaleContext value={preferences.locale}>
      <ChatUiProvider value={chatUi}>
        <Shell preferences={preferences} setPreferences={setPreferences} />
      </ChatUiProvider>
    </LocaleContext>
  )
}
function Shell({
  preferences,
  setPreferences,
}: {
  preferences: UiPreferences
  setPreferences: (preferences: UiPreferences) => void
}) {
  const t = useT()
  const [view, setView] = useState<View>('chat')
  const [hosts, setHosts] = useState<HostTarget[]>([])
  const [bots, setBots] = useState<Bot[]>([])
  const [botId, setBotId] = useState<string>()
  const [draft, setDraft] = useState<OnboardingDraft | null>(null)
  const [connection, setConnection] = useState<Connection>({ connected: false, alias: null })
  const [error, setError] = useState('')
  const [failedTarget, setFailedTarget] = useState<HostTarget>()
  const [booting, setBooting] = useState(true)
  const [panel, setPanel] = useState<{ kind: 'details' } | { kind: 'team-details' } | { kind: 'preview'; name: string; text: string }>()
  const [teams, setTeams] = useState<Team[]>([])
  const [teamId, setTeamId] = useState<string>()
  const [teamDetails, setTeamDetails] = useState<TeamDetailsShape>()
  const [desktopBotId, setDesktopBotId] = useState<string>()
  const [desktopExpanded, setDesktopExpanded] = useState(false)
  const desktopOpener = useRef<HTMLElement | null>(null)
  const chatStates = useRef(new Map<string, ChatState>())
  const teamStates = useRef(new Map<string, TeamChatState>())
  const retries = useRef(0)
  const reconnectTarget = useRef<HostTarget | undefined>(undefined)
  const connecting = useRef(false)
  const lastRetry = useRef(0)
  const wasConnected = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  const bot = bots.find((value) => value.id === botId)
  const returnView = useRef<'chat' | 'onboarding'>('chat')
  const currentView = useRef(view)
  currentView.current = view
  const preferenceRevision = useRef(0)
  const preferenceQueue = useRef<Promise<unknown>>(Promise.resolve())
  const savePreferences = async (patch: Partial<UiPreferences>) => {
    const revision = ++preferenceRevision.current
    const previous = preferences
    setPreferences({ ...preferences, ...patch })
    const request = preferenceQueue.current.catch(() => undefined).then(() => window.bot.savePreferences(patch))
    preferenceQueue.current = request
    try {
      const saved = await request
      if (revision === preferenceRevision.current) setPreferences(saved)
    } catch (error) {
      if (revision === preferenceRevision.current) setPreferences(previous)
      throw error
    }
  }
  const refreshHosts = async () => setHosts(await window.bot.hosts())
  /** Teams exist only on a Host that knows about them; an older one simply shows no section. */
  const teamsSupported = connection.teamSupport === 'available'
  // Both are advertised by the Host; voice only when it can actually transcribe.
  const routinesSupported = connection.routineSupport === 'available'
  const voiceSupported = connection.voiceSupport === 'available'
  const chatSupported = connection.chatSupport === 'available'
  const refreshTeams = async (preferred?: string) => {
    if (!teamsSupported) return
    const next = await window.bot.team({ method: 'team.list', params: {} })
    setTeams(next)
    const chosen = next.find((team) => team.id === (preferred ?? teamId))?.id
    if (chosen) setTeamId(chosen)
    else if (preferred) setTeamId(undefined)
  }
  const openTeam = async (team: Team) => {
    // Switching away from a bot closes its screen: one member's pixels never appear elsewhere.
    setDesktopBotId(undefined)
    setDesktopExpanded(false)
    setPanel(undefined)
    setTeamId(team.id)
    setView('team')
    try {
      setTeamDetails(await window.bot.team({ method: 'team.inspect', params: { teamId: team.id } }))
    } catch (error) {
      setError(String(error))
    }
  }
  const refreshBots = async (preferred?: string) => {
    const next = await window.bot.bot({ method: 'bot.list', params: {} })
    setBots(next)
    setBotId((current) => next.find((value) => value.id === (preferred ?? current))?.id ?? next[0]?.id)
  }
  const connect = async (target: HostTarget) => {
    connecting.current = true
    try {
      const next = await window.bot.connect(target.id)
      if (!next.connected) throw new Error(next.error ?? t('connectionReason'))
      reconnectTarget.current = target
      setConnection(next)
      setFailedTarget(undefined)
      setError('')
      if (next.botSupport !== 'host-outdated') await refreshBots(preferences.lastBotId)
      if (next.teamSupport === 'available') await refreshTeams().catch(() => undefined)
    } finally {
      connecting.current = false
    }
  }
  useEffect(() => {
    let alive = true
    const initialize = async () => {
      try {
        const [savedPreferences, targets, savedDraft, status] = await Promise.all([
          window.bot.preferences(),
          window.bot.hosts(),
          window.bot.draft(),
          window.bot.status(),
        ])
        if (!alive) return
        setPreferences(savedPreferences)
        setHosts(targets)
        setDraft(savedDraft)
        setConnection(status)
        const target =
          targets.find((value) => value.id === savedDraft?.targetId) ??
          targets
            .filter((value) => value.lastConnectedAt)
            .sort((a, b) => b.lastConnectedAt!.localeCompare(a.lastConnectedAt!))[0] ??
          (targets.length === 1 ? targets[0] : undefined)
        if (target) {
          reconnectTarget.current = target
          try {
            const next = await window.bot.connect(target.id)
            if (!next.connected) throw new Error(next.error ?? t('connectionReason'))
            setConnection(next)
            if (next.botSupport !== 'host-outdated') await refreshBots(savedPreferences.lastBotId)
            // Teams must reappear after a restart, not only after a reconnection.
            if (next.teamSupport === 'available')
              await window.bot.team({ method: 'team.list', params: {} }).then(setTeams).catch(() => undefined)
          } catch (error) {
            setFailedTarget(target)
            setError(String(error))
          }
        }
        if (savedDraft) setView('onboarding')
      } catch (error) {
        if (alive) setError(String(error))
      } finally {
        if (alive) setBooting(false)
      }
    }
    void initialize()
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])
  useEffect(() => {
    let disposed = false
    let polling = false
    const timer = setInterval(async () => {
      if (polling || connecting.current || currentView.current === 'computers') return
      polling = true
      try {
        const next = await window.bot.status()
        if (disposed) return
        setConnection(next)
        if (!next.connected && wasConnected.current) lastRetry.current = Date.now()
        wasConnected.current = next.connected
        if (next.connected) {
          retries.current = 0
          if (next.target) reconnectTarget.current = next.target
        } else if (
          !failedTarget &&
          reconnectTarget.current &&
          retries.current < 6 &&
          Date.now() - lastRetry.current >= 5000
        ) {
          retries.current++
          lastRetry.current = Date.now()
          try {
            await connect(reconnectTarget.current)
          } catch {
            /* Keep the readable conversation and bounded retry schedule. */
          }
        }
      } catch (error) {
        if (!disposed) setError(String(error))
      } finally {
        polling = false
      }
    }, 1500)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [failedTarget])
  const closePanel = () => {
    setPanel(undefined)
    opener.current?.focus()
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && panel && !document.querySelector('dialog[open], [role="listbox"]')) closePanel()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [panel])
  const openPanel = (value: NonNullable<typeof panel>) => {
    opener.current = document.activeElement as HTMLElement
    setPanel(value)
  }
  const openBot = async (value: Bot) => {
    returnView.current = 'chat'
    await window.bot.saveDraft(null)
    setDraft(null)
    await savePreferences({ lastBotId: value.id })
    setBots((previous) => [...previous.filter((entry) => entry.id !== value.id), value])
    setBotId(value.id)
    setView('chat')
  }
  const newBot = () => {
    setPanel(undefined)
    setView('onboarding')
  }
  const openAccounts = () => {
    if (currentView.current === 'onboarding') returnView.current = 'onboarding'
    setPanel(undefined); setView('accounts')
  }
  const openEnvironments = () => {
    if (currentView.current === 'onboarding') returnView.current = 'onboarding'
    setPanel(undefined); setView('environments')
  }
  const computers = () => {
    setPanel(undefined)
    setView('computers')
  }
  if (bot && !chatStates.current.has(bot.id)) chatStates.current.set(bot.id, createChatState(bot.id))
  if (teamDetails && !teamStates.current.has(teamDetails.team.id))
    teamStates.current.set(teamDetails.team.id, createTeamChatState(teamDetails.team.id))
  const openDesktop = () => {
    if (!bot) return
    desktopOpener.current = document.activeElement as HTMLElement
    setPanel(undefined)
    setDesktopBotId(bot.id)
  }
  const closeDesktop = () => {
    setDesktopBotId(undefined)
    setDesktopExpanded(false)
    desktopOpener.current?.focus()
  }
  const desktopBot = bots.find((value) => value.id === desktopBotId)
  const desktopVisible = !!desktopBot && connection.connected && (view === 'team' || desktopBotId === bot?.id)
  return (
    <div className="app-shell maestrly-ui">
      <aside className="bot-sidebar">
        <div className="brand">
          <span className="mark">m.</span>
          <strong>Maestrly Bot</strong>
        </div>
        <div className="sidebar-label">Bots</div>
        <nav aria-label="Bots">
          {bots.map((value) => (
            <Button
              key={value.id}
              className={value.id === botId ? 'selected' : ''}
              aria-label={value.name}
              onClick={() => {
                returnView.current = 'chat'
                // Switching bots closes the screen: one bot's pixels never appear under another.
                if (value.id !== botId) {
                  setDesktopBotId(undefined)
                  setDesktopExpanded(false)
                }
                setBotId(value.id)
                setView('chat')
                setTeamId(undefined)
                setPanel(undefined)
                void savePreferences({ lastBotId: value.id })
              }}
            >
              <span className="avatar">{value.name.slice(0, 1).toUpperCase()}</span>
              <span className="bot-label">
                <strong>{value.name}</strong>
                <small>
                  {t(
                    !connection.connected
                      ? 'off'
                      : value.status === 'setup'
                        ? 'preparing'
                        : value.activeTurnId
                          ? ['waiting_approval', 'waiting_input', 'needs_attention'].includes(
                              chatStates.current.get(value.id)?.turn?.status ?? ''
                            )
                            ? 'attention'
                            : 'working'
                          : value.status === 'needs_attention'
                            ? 'attention'
                            : 'ready'
                  )}
                </small>
              </span>
            </Button>
          ))}
        </nav>
        <Button disabled={booting} className="new-bot" aria-label={t('newBot')} onClick={newBot}>
          <Plus size={16} aria-hidden="true" />
          <span className="bot-label">{t('newBot')}</span>
        </Button>
        {teamsSupported && (
          <TeamsList
            teams={teams}
            selectedId={view === 'team' ? teamId : undefined}
            disabled={booting || !connection.connected}
            onSelect={(team) => void openTeam(team)}
            onCreate={() => {
              setPanel(undefined)
              setDesktopBotId(undefined)
              setView('team-create')
            }}
          />
        )}
        <footer>
          <Button aria-label={t('environments')} disabled={booting} onClick={openEnvironments}><Monitor size={16} aria-hidden="true" /><span className="bot-label">{t('environments')}</span></Button>
          <Button aria-label={t('accounts')} disabled={booting} onClick={openAccounts}><UserRound size={16} aria-hidden="true" /><span className="bot-label">{t('accounts')}</span></Button>
          <Button
            aria-label={t('settings')}
            disabled={booting}
            onClick={() => {
              setPanel(undefined)
              setView('settings')
            }}
          >
            <Settings2 size={16} aria-hidden="true" />
            <span className="bot-label">{t('settings')}</span>
          </Button>
        </footer>
      </aside>
      <main className="workspace">
        {(['settings', 'computers', 'accounts', 'environments'].includes(view)) && (
          <Button
            className="back-button"
            onClick={() => {
              setView(returnView.current)
              void window.bot
                .status()
                .then(async (status) => {
                  setConnection(status)
                  if (status.connected && status.botSupport !== 'host-outdated') await refreshBots()
                })
                .catch((error) => setError(String(error)))
              void refreshHosts()
            }}
          >
            {t(returnView.current === 'onboarding' ? 'returnToCreation' : 'back')}
          </Button>
        )}
        {view === 'accounts' ? <AccountsPage onEnvironments={openEnvironments} /> : view === 'environments' ? <EnvironmentsPage hosts={hosts} connect={connect} refreshHosts={refreshHosts} advanced={computers} /> : view === 'computers' ? (
          <ComputersPage />
        ) : view === 'settings' ? (
          <Settings preferences={preferences} save={savePreferences} computers={computers} bots={bots} connected={connection.connected} commandsSupported={chatSupported} />
        ) : (
          <>
            {failedTarget && (
              <div className="alert" role="alert">
                <p>
                  {t('connectFailed')} {failedTarget.displayName}
                </p>
                <Button onClick={() => void connect(failedTarget).catch((error) => setError(String(error)))}>
                  {t('retry')}
                </Button>
                <Button onClick={computers}>{t('chooseComputer')}</Button>
              </div>
            )}
            {!connection.connected && !failedTarget && reconnectTarget.current && (
              <div className="connection-banner" role="status">
                {t('noConnection')} {reconnectTarget.current.displayName}.{' '}
                {retries.current < 6 ? (
                  t('reconnecting')
                ) : (
                  <Button
                    onClick={() => {
                      retries.current = 0
                      void connect(reconnectTarget.current!).catch((error) => setError(String(error)))
                    }}
                  >
                    {t('retry')}
                  </Button>
                )}
              </div>
            )}
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
            {connection.botSupport === 'host-outdated' ? (
              <section className="empty">
                <h1>{t('outdated')}</h1>
                <Button onClick={computers}>{t('computers')}</Button>
              </section>
            ) : view === 'onboarding' ? (
              <FirstBot
                hosts={hosts}
                initialDraft={draft}
                onAccounts={openAccounts}
                onEnvironments={openEnvironments}
                onDraft={setDraft}
                connect={connect}
                refreshHosts={refreshHosts}
                onReady={(value) => void openBot(value)}
              />
            ) : view === 'team-create' ? (
              <CreateTeam
                bots={bots}
                onCancel={() => setView(teamId ? 'team' : 'chat')}
                onCreated={(created) => {
                  void refreshTeams(created).then(async () => {
                    setTeamId(created)
                    setView('team')
                    setTeamDetails(await window.bot.team({ method: 'team.inspect', params: { teamId: created } }))
                  })
                }}
              />
            ) : view === 'team' && teamDetails ? (
              <div className={`chat-layout${desktopVisible ? ' with-desktop' : ''}${desktopVisible && desktopExpanded ? ' desktop-expanded' : ''}`}>
                <TeamChat
                  key={teamDetails.team.id}
                  details={teamDetails}
                  bots={bots}
                  connected={connection.connected}
                  state={teamStates.current.get(teamDetails.team.id)!}
                  onDetails={() => openPanel({ kind: 'team-details' })}
                  onRefreshed={setTeamDetails}
                  onOpenScreen={(memberId) => {
                    // The member's own screen, opened under that member's identity.
                    desktopOpener.current = document.activeElement as HTMLElement
                    setBotId(memberId)
                    setDesktopBotId(memberId)
                  }}
                />
                {desktopVisible && desktopBot && (
                  <BotDesktopPanel key={desktopBot.id} bot={desktopBot} expanded={desktopExpanded} onExpand={() => setDesktopExpanded((value) => !value)} onClose={closeDesktop} />
                )}
              </div>
            ) : bot ? (
              <div className={`chat-layout${desktopVisible ? ' with-desktop' : ''}${desktopVisible && desktopExpanded ? ' desktop-expanded' : ''}`}>
                <BotChat
                  onBotUpdate={(value) =>
                    setBots((previous) => previous.map((entry) => (entry.id === value.id ? value : entry)))
                  }
                  key={bot.id}
                  bot={bot}
                  connected={connection.connected}
                  state={chatStates.current.get(bot.id)!}
                  details={() => openPanel({ kind: 'details' })}
                  onPreview={(name, text) => openPanel({ kind: 'preview', name, text })}
                  onOpenDesktop={connection.connected ? openDesktop : undefined}
                  desktopOpen={desktopVisible}
                  hostId={connection.hostId ?? ''}
                  voiceSupported={voiceSupported}
                  routinesSupported={routinesSupported}
                  chatSupported={chatSupported}
                />
                {desktopVisible && (
                  <BotDesktopPanel key={bot.id} bot={bot} expanded={desktopExpanded} onExpand={() => setDesktopExpanded((value) => !value)} onClose={closeDesktop} />
                )}
              </div>
            ) : (
              <section className="empty">
                <h1>{t('home')}</h1>
                <p>{t('intro')}</p>
                <Button className="primary" disabled={booting} onClick={newBot}>
                  {t('firstBot')}
                </Button>
              </section>
            )}
          </>
        )}
      </main>
      {panel && (
        <aside className="side-panel" role="region" aria-label={panel.kind === 'preview' ? panel.name : t('details')}>
          <header>
            <h2>{panel.kind === 'preview' ? panel.name : t('details')}</h2>
            <Button autoFocus aria-label={t('close')} onClick={closePanel}>
              ×
            </Button>
          </header>
          {panel.kind === 'preview' ? (
            <pre>{panel.text}</pre>
          ) : panel.kind === 'team-details' ? (
            teamDetails && (
              <TeamDetails
                details={teamDetails}
                bots={bots}
                advanced={preferences.advanced}
                connected={connection.connected}
                routinesSupported={routinesSupported}
                onChanged={setTeamDetails}
                onArchived={() => {
                  closePanel()
                  setView('chat')
                  setTeamId(undefined)
                  setTeamDetails(undefined)
                  void refreshTeams()
                }}
              />
            )
          ) : (
            bot && (
              <BotDetails
                onAccounts={openAccounts}
                onOpenDesktop={connection.connected ? openDesktop : undefined}
                bot={bot}
                advanced={preferences.advanced}
                onUpdate={(value) =>
                  setBots((previous) => previous.map((entry) => (entry.id === value.id ? value : entry)))
                }
                onArchive={() => {
                  closePanel()
                  void refreshBots()
                }}
                onPreview={(name, text) => setPanel({ kind: 'preview', name, text })}
                connected={connection.connected}
                routinesSupported={routinesSupported}
                extensionsSupported={chatSupported}
              />
            )
          )}
        </aside>
      )}
    </div>
  )
}
