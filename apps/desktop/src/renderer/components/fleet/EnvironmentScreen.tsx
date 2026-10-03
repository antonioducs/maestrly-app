import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Maximize2, Minimize2, Monitor, X } from 'lucide-react'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { fleetErrorText } from '@/lib/fleet/errors'
import { environmentScreenAvailability } from '@/lib/fleet/provisioning'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { BotPaneSwitch, type BotPane } from './BotPaneSwitch'
import { ScreenFrame, useFleetScreen } from './ScreenFrame'

const CONTROL_BAR_HEIGHT = 40
/** Up to two lines under the control bar that say what the owner's keyboard and mouse reach. */
const FOOTER_HEIGHT = 40
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

/**
 * An environment's own screen, beside its overview as a bot's computer is beside its conversation: its Maestrly
 * settings window, where the owner signs in to the accounts and sites its bots share. It holds no bot, so control needs
 * no takeover; the gateway still allows one control session on the display this screen shares with the bots' browser
 * areas. An environment still on an image from before environments has no such screen until it restarts: its settings
 * open in its bot's browser area.
 */
export function EnvironmentScreen({
  environment,
  fleet,
  streaming = true,
  visible = true,
  maximized,
  narrow,
  activePane,
  onShowPane,
  onMaximize,
  onRestore,
  onClose,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  /** False once the pane closes: the screen stays mounted, without a stream. */
  streaming?: boolean
  /** False while something covers the screen, such as the settings panel: it takes no input meanwhile. */
  visible?: boolean
  maximized: boolean
  narrow: boolean
  activePane: BotPane
  onShowPane: (pane: BotPane) => void
  onMaximize: () => void
  onRestore: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('fleet')
  const target = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'view' | 'control'>('view')
  // Closing the screen ends its control: it opens again to watch.
  useEffect(() => {
    if (!streaming) setMode('view')
  }, [streaming])
  const shaded = environment.lifecycle !== 'running'
  const stopped = environment.lifecycle === 'stopped' || environment.lifecycle === 'failed'
  const oldImage = environmentScreenAvailability(environment) === 'restart-environment'
  const screen = useFleetScreen({
    container: target,
    kind: 'environment',
    id: environment.id,
    surface: null,
    mode,
    disabled: shaded || oldImage || !streaming,
  })
  const controlling = mode === 'control' && !screen.conflict && !shaded && !oldImage
  const alone = maximized || narrow
  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 pl-4 pr-3">
        {alone && <p className="min-w-0 truncate text-sm font-semibold">{environment.name}</p>}
        <div className="inline-flex h-[34px] min-w-0 shrink-0 items-center gap-2 rounded-[10px] border border-border bg-white/[0.05] pl-3 pr-[5px] text-[13px]">
          <Monitor aria-hidden="true" className="size-4 shrink-0 text-foreground/75" />
          <span className="truncate">{t('environment.screen')}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('environment.closeScreen')}
            title={t('environment.closeScreen')}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        <p className="hidden min-w-0 truncate text-[11.5px] text-muted-foreground @md:block">
          {t('environment.screenMeta', { name: environment.name })}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {narrow ? (
            <BotPaneSwitch
              active={activePane}
              onChange={onShowPane}
              labels={{
                group: t('workspace.panes'),
                chat: t('environment.overview'),
                computer: t('environment.screen'),
              }}
            />
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="size-[30px] text-muted-foreground hover:text-foreground"
              aria-label={t(maximized ? 'environment.restoreOverview' : 'environment.maximizeScreen')}
              title={t(maximized ? 'environment.restoreOverview' : 'environment.maximizeScreen')}
              onClick={maximized ? onRestore : onMaximize}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </Button>
          )}
        </div>
      </header>
      {/* A size container: the frame takes the largest desktop that fits above the control bar. */}
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-[22px] pt-2 [container-type:size]"
        style={{ gap: STAGE_GAP }}
      >
        <ScreenFrame
          container={target}
          label={t('environment.region', { name: environment.name })}
          interactive={controlling && visible}
          clipboardError={screen.clipboardError}
          variant="window"
          controlling={controlling}
          reserve={CONTROL_BAR_HEIGHT + FOOTER_HEIGHT + STAGE_GAP}
        >
          {shaded && (
            <ScreenOverlay>
              {stopped ? (
                <>
                  <p className="text-base font-semibold">{t('environment.stopped')}</p>
                  <Button
                    className="h-9 rounded-full px-[18px]"
                    onClick={() => void fleet.environmentAction(environment.id, 'start')}
                  >
                    {t('environment.start')}
                  </Button>
                </>
              ) : (
                <>
                  <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
                  <p>{t('environment.starting')}</p>
                </>
              )}
            </ScreenOverlay>
          )}
          {!shaded && oldImage && (
            <ScreenOverlay>
              <p className="max-w-sm">{t('screen.restartEnvironment')}</p>
            </ScreenOverlay>
          )}
          {!shaded && !oldImage && screen.phase === 'offline' && (
            <ScreenOverlay>
              <p>{t('environment.stopped')}</p>
            </ScreenOverlay>
          )}
          {!shaded && !oldImage && screen.phase === 'connecting' && (
            <ScreenOverlay role="status">
              <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
              <p>{t('screen.phase.connecting')}</p>
            </ScreenOverlay>
          )}
          {!shaded && !oldImage && screen.phase === 'error' && (
            <ScreenOverlay role="status">
              <h2 className="text-base font-semibold">{t('computer.unavailable')}</h2>
              <Button className="h-9 rounded-full px-[18px]" onClick={screen.reconnect}>
                {t('computer.retry')}
              </Button>
            </ScreenOverlay>
          )}
        </ScreenFrame>
        <div className="flex w-full max-w-2xl flex-col items-center gap-1.5">
          <div className="flex shrink-0 items-center gap-3.5" style={{ height: CONTROL_BAR_HEIGHT }}>
            <span role="status" className="inline-flex items-center gap-2 text-sm font-medium">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${controlling ? 'bg-status-ready' : 'bg-muted-foreground'}`}
              />
              {controlling ? t('computer.holderYou') : t('environment.watching')}
            </span>
            {controlling ? (
              <Button
                variant="outline"
                className="h-9 rounded-full px-[18px] text-[13.5px]"
                onClick={() => setMode('view')}
              >
                {t('environment.release')}
              </Button>
            ) : (
              <Button
                className="h-9 rounded-full px-[18px] text-[13.5px]"
                disabled={shaded || oldImage}
                onClick={() => {
                  screen.retryControl()
                  setMode('control')
                }}
              >
                {t('screen.takeControl')}
              </Button>
            )}
          </div>
          <p className="line-clamp-2 w-full text-balance text-center text-xs leading-[17px] text-muted-foreground">
            {controlling
              ? t('environment.footerControl', { name: environment.name })
              : t('environment.footerView', { name: environment.name })}
          </p>
          {screen.conflict && (
            <p role="alert" className="text-center text-xs text-destructive">
              {t('screen.conflict')}
            </p>
          )}
          {screen.error && (
            <p role="alert" className="text-center text-xs text-destructive">
              {fleetErrorText(screen.error, t)}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
