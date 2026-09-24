import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetTakeoverState } from '@maestrly/bot-fleet-protocol'
import RFB from '@novnc/novnc'
import { Button } from '@/components/ui/button'
import { FleetScreenChannel } from '@/lib/fleet/screen-channel'
import { fleetErrorMessage, isTakeoverConflict } from '@/lib/fleet/errors'
import { formatTimer } from '@/lib/fleet/forms'
import { ownsTakeover, takeoverBlocksResume } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'

export function BotScreen({
  bot,
  fleet,
  onOpenSettings,
}: {
  bot: FleetBot
  fleet: FleetController
  onOpenSettings: () => void
}) {
  const { t } = useTranslation('fleet')
  const target = useRef<HTMLDivElement>(null)
  const [takeover, setTakeover] = useState<FleetTakeoverState>(bot.takeover)
  const [phase, setPhase] = useState<'connecting' | 'live' | 'offline' | 'error'>('connecting')
  const [popover, setPopover] = useState<'take' | 'give' | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState(false)
  const [now, setNow] = useState(Date.now())
  const retryRef = useRef(0)
  const [attempt, setAttempt] = useState(0)
  const human = ownsTakeover(takeover, fleet.state.connection.deviceId)
  const otherHuman = takeover.state === 'human' && !human
  const mode = human ? 'control' : 'view'
  const shaded = bot.status === 'offline' || bot.status === 'starting'
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
  useEffect(() => {
    if (shaded || !target.current) return
    let disposed = false
    let channel: FleetScreenChannel | null = null
    let rfb: RFB | null = null
    setPhase('connecting')
    void FleetScreenChannel.open(window.api, bot.id, mode, (state) => {
      if (disposed) return
      if (state.state === 'open') setPhase('live')
      if (state.state === 'error') setPhase('error')
      if (state.state === 'closed') {
        if (state.code === 4001) {
          setTakeover((value) => ({ ...value, state: 'none', since: null }))
          setPhase('connecting')
        } else if (state.code === 4002) setPhase('offline')
        else if (state.code === 4003 && retryRef.current < 1) {
          retryRef.current++
          setAttempt((value) => value + 1)
        } else setPhase('error')
      }
    })
      .then((opened) => {
        if (disposed) {
          opened.close()
          return
        }
        channel = opened
        if (Number(opened.readyState) === WebSocket.OPEN) setPhase('live')
        const remote = new RFB(target.current!, opened, { shared: true })
        remote.viewOnly = mode === 'view'
        remote.scaleViewport = true
        remote.resizeSession = false
        remote.qualityLevel = 6
        remote.compressionLevel = 4
        remote.addEventListener('connect', () => {
          setPhase('live')
          if (mode === 'control') remote.focus({ preventScroll: true })
        })
        remote.addEventListener('disconnect', () => {
          if (!disposed) setPhase((value) => (value === 'offline' ? value : 'error'))
        })
        rfb = remote
      })
      .catch((cause) => {
        if (!disposed) {
          setError(fleetErrorMessage(cause))
          setPhase('error')
        }
      })
    return () => {
      disposed = true
      rfb?.disconnect()
      channel?.close()
    }
  }, [bot.id, mode, shaded, attempt])

  async function take(openAccounts = false) {
    setBusy(true)
    setError('')
    setPopover(null)
    try {
      const state = await window.api.fleetTakeover(bot.id)
      setTakeover(state)
      retryRef.current = 0
      if (openAccounts) await window.api.fleetUiOpen(bot.id, { target: 'accounts' })
    } catch (cause) {
      setError(isTakeoverConflict(cause) ? t('screen.takeConflict') : fleetErrorMessage(cause))
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
      retryRef.current = 0
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <span className="rounded-full bg-surface-elevated px-2 py-1 text-xs font-medium text-status-ready">
          ● {t('screen.live')}
        </span>
        <div
          role="status"
          aria-label={t('screen.holder', {
            name: human ? t('screen.you') : otherHuman ? (takeover.deviceName ?? t('screen.unknownDevice')) : bot.name,
          })}
          className="relative flex items-center gap-1 rounded-full border border-border p-1 text-xs"
        >
          <span className="relative z-10 px-2 py-1">{bot.name}</span>
          <span className="relative z-10 px-2 py-1">
            {otherHuman ? (takeover.deviceName ?? t('screen.unknownDevice')) : t('screen.you')}
          </span>
          <span
            aria-hidden="true"
            className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-surface-elevated transition-transform motion-reduce:transition-none ${takeover.state === 'human' ? 'translate-x-full' : ''}`}
          />
        </div>
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
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/85 p-4">
        <div
          ref={target}
          role="region"
          aria-label={t('screen.region', { name: bot.name })}
          onClick={() => {
            if (!human) {
              setHint(true)
              window.setTimeout(() => setHint(false), 2200)
            }
          }}
          className={`relative h-full w-full [&_canvas]:mx-auto ${human ? 'cursor-default [&_canvas]:cursor-default' : 'cursor-not-allowed [&_canvas]:cursor-not-allowed'}`}
        />
        {hint && !human && (
          <p
            role="status"
            className="pointer-events-none absolute bottom-8 rounded-full bg-popover px-3 py-2 text-xs shadow"
          >
            {t('screen.viewHint')}
          </p>
        )}
        {shaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-white">
            <p>{bot.status === 'offline' ? t('screen.stopped') : t('screen.starting')}</p>
            {bot.status === 'offline' && (
              <Button onClick={() => void fleet.botAction(bot.id, 'start')}>{t('action.start')}</Button>
            )}
          </div>
        )}
        {!shaded && phase === 'offline' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-sm text-white">
            {t('screen.phase.offline')}
          </div>
        )}
        {!shaded && bot.status === 'setup' && !takeoverBlocksResume(takeover) && (
          <div className="absolute inset-x-4 top-4 mx-auto max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
            <h2 className="font-semibold">{t('screen.connectAccount')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('screen.accountDescription', { name: bot.name })}</p>
            <Button className="mt-4" disabled={busy} onClick={() => void take(true)}>
              {t('screen.useScreen')}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              <button type="button" className="text-primary underline" onClick={onOpenSettings}>
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
      </div>
      {error && (
        <p role="alert" className="px-5 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {bot.status === 'paused' && <p className="px-5 py-1 text-xs text-muted-foreground">{t('screen.paused')}</p>}
      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">{footer}</p>
    </div>
  )
}
