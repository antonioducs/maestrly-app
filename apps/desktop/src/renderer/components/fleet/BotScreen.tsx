import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetScreenSurface, FleetTakeoverState } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { fleetErrorMessage, isTakeoverConflict } from '@/lib/fleet/errors'
import { hasEnvironments, startBot } from '@/lib/fleet/environments'
import { formatTimer, nextRadioIndex } from '@/lib/fleet/forms'
import { environmentOf, ownsTakeover, takeoverBlocksResume } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { ScreenFrame, useFleetScreen } from './ScreenFrame'

const surfaces = ['browser', 'apps'] as const

export function BotScreen({
  bot,
  fleet,
  onOpenSettings,
  onOpenEnvironment,
  onOpenEnvironmentScreen,
}: {
  bot: FleetBot
  fleet: FleetController
  onOpenSettings: () => void
  onOpenEnvironment?: () => void
  onOpenEnvironmentScreen?: () => void
}) {
  const { t } = useTranslation('fleet')
  const target = useRef<HTMLDivElement>(null)
  const surfaceRadios = useRef<Array<HTMLButtonElement | null>>([])
  const [takeover, setTakeover] = useState<FleetTakeoverState>(bot.takeover)
  const [surface, setSurface] = useState<FleetScreenSurface>('browser')
  const [popover, setPopover] = useState<'take' | 'give' | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  // With environments a bot has a browser area and an apps screen; before them, its browser area only.
  const environments = hasEnvironments(fleet.state.connection)
  const environment = environments ? environmentOf(fleet.state.snapshot.environments, bot) : undefined
  const human = ownsTakeover(takeover, fleet.state.connection.deviceId)
  const otherHuman = takeover.state === 'human' && !human
  const mode = human ? 'control' : 'view'
  const shaded = bot.status === 'offline' || bot.status === 'starting'
  const screen = useFleetScreen({
    container: target,
    kind: 'bot',
    id: bot.id,
    surface: environments ? surface : null,
    mode,
    disabled: shaded,
    onControlLost: () => setTakeover((value) => ({ ...value, state: 'none', since: null })),
  })
  const phase = screen.phase
  const pendingHelp = fleet.state.snapshot.inbox.some(
    (item) => item.botId === bot.id && item.interaction.kind === 'help'
  )
  useEffect(() => {
    setTakeover(bot.takeover)
    if (takeoverBlocksResume(bot.takeover)) setPopover(null)
  }, [bot.takeover])
  useEffect(() => {
    if (mode !== 'control') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [mode])

  function onSurfaceKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextRadioIndex(index, event.key, surfaces.length)
    if (next === null) return
    event.preventDefault()
    setSurface(surfaces[next])
    surfaceRadios.current[next]?.focus()
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
      setError(isTakeoverConflict(cause) ? t('screen.takeConflict') : fleetErrorMessage(cause))
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
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const footer = human
    ? t('screen.footerHuman', {
        name: bot.name,
        host: fleet.state.snapshot.host?.hostname ?? '',
      })
    : otherHuman
      ? t('screen.footerOther', {
          name: takeover.deviceName ?? t('screen.unknownDevice'),
        })
      : bot.status === 'waiting' && pendingHelp
        ? t('screen.footerWaiting', { name: bot.name })
        : t('screen.footerView', {
            name: bot.name,
            host: fleet.state.snapshot.host?.hostname ?? '',
          })
  const alert = error || screen.error
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <span className="rounded-full bg-surface-elevated px-2 py-1 text-xs font-medium text-status-ready">
          ● {t('screen.live')}
        </span>
        {/* Two equal columns: the half-width indicator must cover one name exactly, whatever their lengths. */}
        <div
          role="status"
          aria-label={t('screen.holder', {
            name: human ? t('screen.you') : otherHuman ? (takeover.deviceName ?? t('screen.unknownDevice')) : bot.name,
          })}
          className="relative grid max-w-xs grid-cols-2 items-center rounded-full border border-border p-1 text-xs"
        >
          <span
            className={`relative z-10 min-w-0 truncate px-3 py-1 text-center ${takeover.state === 'human' ? 'text-muted-foreground' : ''}`}
          >
            {bot.name}
          </span>
          <span
            className={`relative z-10 min-w-0 truncate px-3 py-1 text-center ${takeover.state === 'human' ? '' : 'text-muted-foreground'}`}
          >
            {otherHuman ? (takeover.deviceName ?? t('screen.unknownDevice')) : t('screen.you')}
          </span>
          <span
            aria-hidden="true"
            className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-surface-elevated transition-transform motion-reduce:transition-none ${takeover.state === 'human' ? 'translate-x-full' : ''}`}
          />
        </div>
        {environments && (
          <div
            role="radiogroup"
            aria-label={t('screen.surface')}
            className="flex items-center gap-1 rounded-lg border border-border p-0.5"
          >
            {surfaces.map((name, index) => (
              <button
                key={name}
                ref={(node) => {
                  surfaceRadios.current[index] = node
                }}
                type="button"
                role="radio"
                aria-checked={surface === name}
                tabIndex={surface === name ? 0 : -1}
                onClick={() => setSurface(name)}
                onKeyDown={(event) => onSurfaceKey(event, index)}
                className={`rounded-md px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${surface === name ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {name === 'browser' ? t('screen.browser') : t('screen.apps')}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {human ? (
            <>
              <span className="font-mono text-xs" aria-label={t('screen.controlTime')}>
                {formatTimer(now - Date.parse(takeover.since ?? new Date(now).toISOString()))}
              </span>
              <Button size="sm" onClick={() => setPopover('give')}>
                {t('screen.giveBack', { name: bot.name })}
              </Button>
            </>
          ) : !takeoverBlocksResume(takeover) ? (
            <Button
              size="sm"
              disabled={shaded || busy}
              className={pendingHelp ? 'animate-[pulse_1s_ease-in-out_1] motion-reduce:animate-none' : ''}
              onClick={() => setPopover('take')}
            >
              {t('screen.takeControl')}
            </Button>
          ) : null}
        </div>
        {popover && (
          <div
            role="dialog"
            aria-label={
              popover === 'take' ? t('screen.takeTitle', { name: bot.name }) : t('screen.giveTitle', { name: bot.name })
            }
            className="absolute right-5 top-full z-20 mt-1 w-80 max-w-[90vw] rounded-lg border border-border bg-popover p-4 shadow-xl"
          >
            <h2 className="font-semibold">
              {popover === 'take'
                ? t('screen.takeTitle', { name: bot.name })
                : t('screen.giveTitle', { name: bot.name })}
            </h2>
            {popover === 'take' ? (
              <p className="mt-2 text-xs text-muted-foreground">{t('screen.takeDescription', { name: bot.name })}</p>
            ) : (
              <label className="mt-2 block text-xs">
                {t('screen.giveDescription', { name: bot.name })}
                <textarea
                  value={note}
                  maxLength={1000}
                  autoFocus
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t('screen.optional')}
                  className="mt-2 min-h-20 w-full rounded-md border border-input bg-surface-elevated p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPopover(null)}>
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
      <ScreenFrame container={target} label={t('screen.region', { name: bot.name })} interactive={human}>
        {shaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-white">
            <p>{bot.status === 'offline' ? t('screen.stopped') : t('screen.starting')}</p>
            {bot.status === 'offline' && <Button onClick={() => void startBot(fleet, bot)}>{t('action.start')}</Button>}
          </div>
        )}
        {!shaded && phase === 'offline' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-sm text-white">
            {t('screen.phase.offline')}
          </div>
        )}
        {!shaded &&
          bot.status === 'setup' &&
          bot.activity?.kind === 'setup' &&
          bot.activity.need === 'account' &&
          !takeoverBlocksResume(takeover) && (
            <div className="absolute inset-x-4 top-4 mx-auto max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
              <h2 className="font-semibold">{t('screen.connectAccount')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {environment
                  ? t('screen.environmentAccountDescription', { name: bot.name, environment: environment.name })
                  : t('screen.accountDescription', { name: bot.name })}
              </p>
              <Button
                className="mt-4"
                disabled={busy}
                onClick={() => void (environment ? openEnvironmentAccounts(environment.id) : take(true))}
              >
                {environment ? t('screen.useEnvironmentScreen') : t('screen.useScreen')}
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
        {!shaded && phase !== 'live' && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-4 rounded bg-background/90 px-3 py-2 text-xs"
          >
            {t(`screen.phase.${phase}`)}
          </div>
        )}
      </ScreenFrame>
      {screen.conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 px-5 py-2 text-xs text-destructive">
          {t('screen.conflict')}
          <Button size="sm" variant="outline" onClick={screen.retryControl}>
            {t('screen.retryControl')}
          </Button>
        </div>
      )}
      {alert && (
        <p role="alert" className="px-5 py-2 text-xs text-destructive">
          {alert}
        </p>
      )}
      {bot.status === 'paused' && <p className="px-5 py-1 text-xs text-muted-foreground">{t('screen.paused')}</p>}
      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">{footer}</p>
    </div>
  )
}
