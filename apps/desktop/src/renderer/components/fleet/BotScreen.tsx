import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetScreenSurface, FleetTakeoverState } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { fleetErrorText, isTakeoverConflict } from '@/lib/fleet/errors'
import { hasEnvironments, startBot } from '@/lib/fleet/environments'
import { botFirstName } from '@/lib/fleet/format'
import { formatTimer } from '@/lib/fleet/forms'
import { environmentScreenAvailability, type BotComputerMode } from '@/lib/fleet/provisioning'
import { environmentOf, ownsTakeover, takeoverBlocksResume } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { BotWorkspaceMode } from '@/lib/fleet/use-bot-workspace-layout'
import { BotComputerHeader, ScreenSurfaceToggle } from './BotComputerHeader'
import type { BotPane } from './BotPaneSwitch'
import { ScreenFrame, useFleetScreen } from './ScreenFrame'

/** The bar under the frame and the gap that separates them: the frame leaves them free. */
const CONTROL_BAR_HEIGHT = 40
const STAGE_GAP = 18

function ScreenOverlay({ role, children }: { role?: 'status'; children: ReactNode }) {
  return (
    <div
      role={role}
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/75 p-6 text-center text-sm text-white backdrop-blur-md"
    >
      {children}
    </div>
  )
}

export function BotScreen({
  bot,
  fleet,
  mode,
  layoutMode,
  narrow,
  activePane,
  giveBackRequest,
  onReveal,
  onShowPane,
  onMaximize,
  onRestore,
  onClose,
  onOpenSettings,
  onOpenEnvironment,
  onOpenEnvironmentScreen,
  streaming = true,
  visible = true,
}: {
  bot: FleetBot
  fleet: FleetController
  /** How the computer is laid out: one desktop, a choice of two areas, or only the browser. */
  mode: BotComputerMode
  /** How the workspace lays the computer out: beside the conversation, or maximized. */
  layoutMode: BotWorkspaceMode
  narrow: boolean
  activePane: BotPane
  /** Each increment opens the return dialog: the owner asked to give control back from elsewhere. */
  giveBackRequest: number
  /** Brings this pane into view; the return dialog lives here. */
  onReveal: () => void
  onShowPane: (pane: BotPane) => void
  onMaximize: () => void
  onRestore: () => void
  /** Closes the computer, once the owner is no longer controlling it. */
  onClose: () => void
  onOpenSettings: () => void
  onOpenEnvironment?: () => void
  onOpenEnvironmentScreen?: () => void
  streaming?: boolean
  visible?: boolean
}) {
  const { t } = useTranslation('fleet')
  const target = useRef<HTMLDivElement>(null)
  const [takeover, setTakeover] = useState<FleetTakeoverState>(bot.takeover)
  const [surface, setSurface] = useState<FleetScreenSurface>('browser')
  const [popover, setPopover] = useState<'take' | 'give' | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const pendingClose = useRef<(() => void) | null>(null)
  const environments = hasEnvironments(fleet.state.connection)
  const environment = environments ? environmentOf(fleet.state.snapshot.environments, bot) : undefined
  // An environment still on an image from before environments has one display, the bot's browser, where its settings
  // open too: no apps screen and no environment screen until it restarts.
  const oldImage = environment !== undefined && environmentScreenAvailability(environment) === 'restart-environment'
  // The unified desktop is the bot's apps screen; images before it keep two areas to choose from, an image from
  // before environments only its browser (Apps stays in sight, disabled).
  const requested: FleetScreenSurface = mode === 'unified' ? 'apps' : mode === 'browser-only' ? 'browser' : surface
  const accountsEnvironment = oldImage ? undefined : environment
  const human = ownsTakeover(takeover, fleet.state.connection.deviceId)
  const otherHuman = takeover.state === 'human' && !human
  const controlMode = human ? 'control' : 'view'
  const shaded = bot.status === 'offline' || bot.status === 'starting'
  const screen = useFleetScreen({
    container: target,
    kind: 'bot',
    id: bot.id,
    surface: requested,
    mode: controlMode,
    disabled: shaded || !streaming,
    visible,
    autoFocus: false,
    onControlLost: () => setTakeover((value) => ({ ...value, state: 'none', since: null })),
  })
  const phase = screen.phase
  const pendingHelp = fleet.state.snapshot.inbox.some(
    (item) => item.botId === bot.id && item.interaction.kind === 'help'
  )
  useEffect(() => {
    setTakeover(bot.takeover)
    const releasingHere =
      bot.takeover.state === 'releasing' &&
      fleet.state.connection.deviceId !== null &&
      bot.takeover.deviceId === fleet.state.connection.deviceId
    // The gateway broadcasts releasing before the HTTP operation completes. Keep the return dialog and close
    // intent until giveBack succeeds, or restores control on failure.
    if (ownsTakeover(bot.takeover, fleet.state.connection.deviceId) || releasingHere) {
      setPopover((value) => (value === 'take' ? null : value))
    } else if (takeoverBlocksResume(bot.takeover)) {
      pendingClose.current = null
      setPopover(null)
    }
  }, [bot.takeover, fleet.state.connection.deviceId])
  useEffect(() => {
    if (controlMode !== 'control') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [controlMode])
  // The composer's way back: reveal this pane and ask for the note, if the owner still controls the computer.
  const request = useRef({ human, reveal: onReveal })
  request.current = { human, reveal: onReveal }
  useEffect(() => {
    if (giveBackRequest === 0 || !request.current.human) return
    pendingClose.current = null
    request.current.reveal()
    setPopover('give')
  }, [giveBackRequest])

  /** Closing waits for control to be given back: it asks first, and closes once the release succeeded. */
  function requestClose() {
    // Do not disconnect a controller while takeover or release is still in flight.
    if (busy || (takeover.state !== 'none' && takeover.state !== 'human')) return
    if (human) {
      pendingClose.current = onClose
      onReveal()
      setPopover('give')
      return
    }
    onClose()
  }
  async function take(openAccounts = false) {
    setBusy(true)
    setError('')
    setPopover(null)
    try {
      const state = await window.api.fleetTakeover(bot.id)
      setTakeover(state)
      screen.resetRetries()
      screen.retryControl()
      if (openAccounts) await window.api.fleetUiOpen(bot.id, { target: 'accounts' })
    } catch (cause) {
      setError(isTakeoverConflict(cause) ? t('screen.takeConflict') : fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  // Accounts belong to the environment: sign in on its screen, which needs no takeover of any bot.
  async function openEnvironmentAccounts(environmentId: string) {
    setBusy(true)
    setError('')
    try {
      await window.api.fleetEnvironmentUiOpen(environmentId, 'accounts')
      onOpenEnvironmentScreen?.()
    } catch {
      setError(t('environment.screenLoginFailed'))
    } finally {
      setBusy(false)
    }
  }
  async function giveBack() {
    setBusy(true)
    setError('')
    try {
      const state = await window.api.fleetReleaseTakeover(bot.id, {
        note: note.trim() || null,
        continue: true,
      })
      setTakeover(state)
      setPopover(null)
      setNote('')
      screen.resetRetries()
      const close = pendingClose.current
      pendingClose.current = null
      // A completed release must not navigate back if the owner already left this bot.
      if (target.current) close?.()
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const firstName = botFirstName(bot.name)
  const deviceName = takeover.deviceName ?? t('screen.unknownDevice')
  const alert = error || (screen.error && fleetErrorText(screen.error, t))
  const choosesSurface = mode === 'legacy' || oldImage
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BotComputerHeader
        bot={bot}
        maximized={layoutMode === 'computer'}
        narrow={narrow}
        activePane={activePane}
        surfaceToggle={
          choosesSurface && (
            <ScreenSurfaceToggle
              value={requested}
              appsDisabled={oldImage}
              describedBy="fleet-screen-apps-restart"
              title={mode === 'legacy' ? t('computer.legacyNote') : undefined}
              onChange={setSurface}
            />
          )
        }
        onShowPane={onShowPane}
        onMaximize={onMaximize}
        onRestore={onRestore}
        onClose={requestClose}
      />
      {oldImage && (
        <p id="fleet-screen-apps-restart" className="px-4 pb-1 text-xs text-muted-foreground">
          {t('screen.appsNeedsRestart')}
        </p>
      )}
      {/* A size container: the frame takes the largest desktop that fits above the control bar. */}
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-[22px] pt-2 [container-type:size]"
        style={{ gap: STAGE_GAP }}
      >
        <ScreenFrame
          container={target}
          label={t('screen.region', { name: bot.name })}
          interactive={visible && human && !screen.conflict}
          clipboardError={screen.clipboardError}
          variant="window"
          controlling={human && !screen.conflict}
          reserve={CONTROL_BAR_HEIGHT + STAGE_GAP}
        >
          {shaded && (
            <ScreenOverlay>
              {bot.status === 'offline' ? (
                <>
                  <p className="text-base font-semibold">{t('screen.stopped')}</p>
                  <Button className="h-9 rounded-full px-[18px]" onClick={() => void startBot(fleet, bot)}>
                    {t('action.start')}
                  </Button>
                </>
              ) : (
                <>
                  <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
                  <p>{t('screen.starting')}</p>
                </>
              )}
            </ScreenOverlay>
          )}
          {!shaded && phase === 'offline' && (
            <ScreenOverlay>
              <p>{t('screen.phase.offline')}</p>
            </ScreenOverlay>
          )}
          {!shaded && phase === 'connecting' && (
            <ScreenOverlay role="status">
              <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
              <p>{t('screen.phase.connecting')}</p>
            </ScreenOverlay>
          )}
          {!shaded && phase === 'error' && (
            <ScreenOverlay role="status">
              <h2 className="text-base font-semibold">{t('computer.unavailable')}</h2>
              <p className="text-white/75">{t('computer.unavailableDescription')}</p>
              <Button className="h-9 rounded-full px-[18px]" onClick={screen.reconnect}>
                {t('computer.retry')}
              </Button>
            </ScreenOverlay>
          )}
          {!shaded &&
            bot.status === 'setup' &&
            bot.activity?.kind === 'setup' &&
            bot.activity.need === 'account' &&
            !takeoverBlocksResume(takeover) && (
              <div className="absolute inset-x-4 top-4 z-40 mx-auto max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
                <h2 className="font-semibold">{t('screen.connectAccount')}</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {accountsEnvironment
                    ? t('screen.environmentAccountDescription', {
                        name: bot.name,
                        environment: accountsEnvironment.name,
                      })
                    : t('screen.accountDescription', { name: bot.name })}
                </p>
                <Button
                  className="mt-4"
                  disabled={busy}
                  onClick={() =>
                    void (accountsEnvironment ? openEnvironmentAccounts(accountsEnvironment.id) : take(true))
                  }
                >
                  {accountsEnvironment ? t('screen.useEnvironmentScreen') : t('screen.useScreen')}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={environment && onOpenEnvironment ? onOpenEnvironment : onOpenSettings}
                  >
                    {t('screen.addApiKeyInSettings')}
                  </button>
                </p>
              </div>
            )}
        </ScreenFrame>
        <div className="relative flex shrink-0 items-center gap-3.5" style={{ height: CONTROL_BAR_HEIGHT }}>
          {!shaded &&
            (human ? (
              <>
                <span role="status" className="inline-flex items-center gap-2 text-sm font-medium">
                  <span aria-hidden="true" className="size-2 rounded-full bg-status-ready" />
                  {t('computer.holderYou')}
                </span>
                <span className="-ml-1.5 font-mono text-xs text-muted-foreground" aria-label={t('screen.controlTime')}>
                  {formatTimer(now - Date.parse(takeover.since ?? new Date(now).toISOString()))}
                </span>
                <Button
                  className="h-9 rounded-full px-[18px] text-[13.5px]"
                  onClick={() => {
                    pendingClose.current = null
                    setPopover('give')
                  }}
                >
                  {t('computer.giveBackShort', { name: firstName })}
                </Button>
              </>
            ) : (
              <>
                <span role="status" className="inline-flex items-center gap-2 text-sm font-medium">
                  <span
                    aria-hidden="true"
                    className={`size-2 rounded-full ${otherHuman ? 'bg-muted-foreground' : 'fleet-holder-pulse bg-current'}`}
                    style={otherHuman ? undefined : ({ color: bot.tint } satisfies CSSProperties)}
                  />
                  {otherHuman
                    ? t('computer.holderOther', { device: deviceName })
                    : t('computer.holderBot', { name: bot.name })}
                </span>
                {!takeoverBlocksResume(takeover) && (
                  <Button
                    disabled={busy}
                    className={`h-9 rounded-full px-[18px] text-[13.5px] ${pendingHelp ? 'animate-[pulse_1s_ease-in-out_1] motion-reduce:animate-none' : ''}`}
                    onClick={() => setPopover('take')}
                  >
                    {t('screen.takeControl')}
                  </Button>
                )}
              </>
            ))}
          {popover && (
            <div
              role="dialog"
              aria-label={
                popover === 'take'
                  ? t('screen.takeTitle', { name: bot.name })
                  : t('screen.giveTitle', { name: bot.name })
              }
              className="absolute bottom-[calc(100%+10px)] left-1/2 z-40 w-[340px] max-w-[90vw] -translate-x-1/2 rounded-xl border border-border-strong bg-popover p-3.5 backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.6)]"
            >
              <h2 className="text-sm font-semibold">
                {popover === 'take'
                  ? t('screen.takeTitle', { name: bot.name })
                  : t('screen.giveTitle', { name: bot.name })}
              </h2>
              {popover === 'take' ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t('screen.takeDescription', { name: bot.name })}
                </p>
              ) : (
                <label className="mt-2 block text-xs leading-relaxed">
                  {t('screen.giveDescription', { name: bot.name })}
                  <textarea
                    value={note}
                    maxLength={1000}
                    autoFocus
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={t('screen.optional')}
                    className="mt-2 min-h-[72px] w-full rounded-md border border-input bg-white/[0.04] p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    pendingClose.current = null
                    setPopover(null)
                  }}
                >
                  {popover === 'take' ? t('screen.cancel') : t('screen.keepControl')}
                </Button>
                <Button
                  size="sm"
                  autoFocus={popover === 'take'}
                  disabled={busy}
                  onClick={() => void (popover === 'take' ? take() : giveBack())}
                >
                  {popover === 'take' ? t('screen.take') : t('screen.give')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {(screen.conflict || alert || bot.status === 'paused') && (
        <div className="flex shrink-0 flex-col gap-1 px-5 pb-3">
          {screen.conflict && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
              {t('screen.conflict')}
              <Button size="sm" variant="outline" onClick={screen.retryControl}>
                {t('screen.retryControl')}
              </Button>
            </div>
          )}
          {alert && (
            <p role="alert" className="text-xs text-destructive">
              {alert}
            </p>
          )}
          {bot.status === 'paused' && <p className="text-xs text-muted-foreground">{t('screen.paused')}</p>}
        </div>
      )}
    </div>
  )
}
