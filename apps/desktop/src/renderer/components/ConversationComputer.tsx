import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { FLEET_CONVERSATION_COMPUTER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ScreenFrame, useFleetScreen } from '@/components/fleet/ScreenFrame'
import { computerStage } from '@/lib/conversation-computer'
import { fleetErrorText } from '@/lib/fleet/errors'
import { useHostApi } from '@/lib/hosts/host-context'
import { useHostInfo } from '@/lib/hosts/use-hosts'

const CONTROL_BAR_HEIGHT = 40
/** The line under the control bar. */
const FOOTER_HEIGHT = 20
const STAGE_GAP = 14

function Overlay({ role, children }: { role?: 'status'; children: ReactNode }) {
  return (
    <div
      role={role}
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black p-6 text-center text-sm text-white"
    >
      {children}
    </div>
  )
}

/**
 * The computer of a conversation that runs on a server's workspaces environment: its own Linux desktop, which its
 * agent drives with its computer tools. The tab opens it on the server, then watches it over the gateway's screen
 * stream; taking control does not pause the agent, whose input may interleave with the owner's. A computer is given
 * back a minute after nobody shows or uses it, so opening the tab again starts it again.
 */
export function ConversationComputer({ convId, active }: { convId: string; active: boolean }) {
  const { t } = useTranslation('ui')
  const { t: tf } = useTranslation('fleet')
  const api = useHostApi()
  const host = useHostInfo()
  const online = host.state === 'online'
  const environmentId = host.environment?.id ?? null
  const [opened, setOpened] = useState(() => computerStage({ ok: false, reason: 'unavailable' }))
  const [opening, setOpening] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [mode, setMode] = useState<'view' | 'control'>('view')
  const target = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active || !online) return
    let cancelled = false
    setOpening(true)
    api.computerOpen(convId).then(
      (result) => {
        if (cancelled) return
        setOpened(computerStage(result))
        setOpening(false)
      },
      (error: unknown) => {
        if (cancelled) return
        setOpened(computerStage(error instanceof Error ? error : new Error(String(error))))
        setOpening(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [api, convId, active, online, host.epoch, attempt])
  // Leaving the tab gives control back: it opens again to watch.
  useEffect(() => {
    if (!active) setMode('view')
  }, [active])

  const showing = online && !opening && opened.stage === 'screen' && environmentId !== null
  const screen = useFleetScreen({
    container: target,
    kind: 'conversation',
    id: environmentId ?? '',
    conversationId: convId,
    surface: 'apps',
    mode,
    disabled: !active || !showing,
    visible: active,
  })
  const controlling = mode === 'control' && showing && !screen.conflict
  const tryAgain = () => {
    screen.reconnect()
    setAttempt((value) => value + 1)
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-3 pt-3 [container-type:size]"
        style={{ gap: STAGE_GAP }}
      >
        <ScreenFrame
          container={target}
          label={t('drawer.tabComputer')}
          interactive={controlling && active}
          clipboardError={screen.clipboardError}
          variant="window"
          controlling={controlling}
          reserve={CONTROL_BAR_HEIGHT + FOOTER_HEIGHT + STAGE_GAP}
        >
          {!online && (
            <Overlay>
              <p>{t('remoteBrowser.offline')}</p>
            </Overlay>
          )}
          {online && opening && (
            <Overlay role="status">
              <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
              <p>{t('remoteComputer.starting')}</p>
            </Overlay>
          )}
          {online && !opening && opened.stage === 'busy' && (
            <Overlay role="status">
              <p className="max-w-sm">
                {t('remoteComputer.busy', {
                  count: FLEET_CONVERSATION_COMPUTER_LIMITS.slots,
                  holders: opened.holders.join(', '),
                })}
              </p>
              <Button className="h-9 rounded-full px-[18px]" onClick={tryAgain}>
                {t('remoteComputer.tryAgain')}
              </Button>
            </Overlay>
          )}
          {online && !opening && opened.stage === 'unavailable' && (
            <Overlay>
              <p className="max-w-sm">{t('remoteComputer.unavailable')}</p>
            </Overlay>
          )}
          {online && !opening && opened.stage === 'error' && (
            <Overlay role="status">
              <p className="max-w-sm">{fleetErrorText(opened.error, tf)}</p>
              <Button className="h-9 rounded-full px-[18px]" onClick={tryAgain}>
                {t('remoteComputer.tryAgain')}
              </Button>
            </Overlay>
          )}
          {showing && screen.phase === 'connecting' && (
            <Overlay role="status">
              <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
              <p>{tf('screen.phase.connecting')}</p>
            </Overlay>
          )}
          {showing && (screen.phase === 'offline' || screen.phase === 'error') && (
            <Overlay role="status">
              <p className="max-w-sm">{screen.error ? fleetErrorText(screen.error, tf) : tf('computer.unavailable')}</p>
              <Button className="h-9 rounded-full px-[18px]" onClick={tryAgain}>
                {t('remoteComputer.tryAgain')}
              </Button>
            </Overlay>
          )}
        </ScreenFrame>
        <div className="flex w-full max-w-2xl flex-col items-center gap-1">
          <div className="flex shrink-0 items-center gap-3.5" style={{ height: CONTROL_BAR_HEIGHT }}>
            <span role="status" className="inline-flex items-center gap-2 text-sm font-medium">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${controlling ? 'bg-status-ready' : 'bg-muted-foreground'}`}
              />
              {controlling ? t('remoteComputer.controlling') : t('remoteComputer.watching')}
            </span>
            {controlling ? (
              <Button
                variant="outline"
                className="h-9 rounded-full px-[18px] text-[13.5px]"
                onClick={() => setMode('view')}
              >
                {t('remoteComputer.release')}
              </Button>
            ) : (
              <Button
                className="h-9 rounded-full px-[18px] text-[13.5px]"
                disabled={!showing || screen.phase !== 'live'}
                onClick={() => {
                  screen.retryControl()
                  setMode('control')
                }}
              >
                {t('remoteComputer.takeControl')}
              </Button>
            )}
          </div>
          <p
            className="line-clamp-1 w-full text-center text-xs text-muted-foreground"
            style={{ minHeight: FOOTER_HEIGHT }}
          >
            {controlling ? t('remoteComputer.agentKeepsWorking') : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
