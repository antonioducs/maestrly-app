import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { fleetErrorText } from '@/lib/fleet/errors'
import { environmentScreenAvailability } from '@/lib/fleet/provisioning'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { ScreenFrame, useFleetScreen } from './ScreenFrame'

/**
 * An environment's own screen: its Maestrly settings window, where the owner signs in to the accounts and sites its
 * bots share. It holds no bot, so control needs no takeover; the gateway still allows one control session on the
 * display this screen shares with the bots' browser areas. An environment still on an image from before
 * environments has no such screen until it restarts: its settings open in its bot's browser area.
 */
export function EnvironmentScreen({ environment, fleet }: { environment: FleetEnvironment; fleet: FleetController }) {
  const { t } = useTranslation('fleet')
  const target = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'view' | 'control'>('view')
  const shaded = environment.lifecycle !== 'running'
  const stopped = environment.lifecycle === 'stopped' || environment.lifecycle === 'failed'
  const oldImage = environmentScreenAvailability(environment) === 'restart-environment'
  const screen = useFleetScreen({
    container: target,
    kind: 'environment',
    id: environment.id,
    surface: null,
    mode,
    disabled: shaded || oldImage,
  })
  const controlling = mode === 'control' && !screen.conflict
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <span className="rounded-full bg-surface-elevated px-2 py-1 text-xs font-medium text-status-ready">
          ● {t('screen.live')}
        </span>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('environment.screenDescription')}</p>
        {controlling ? (
          <Button size="sm" variant="outline" onClick={() => setMode('view')}>
            {t('environment.release')}
          </Button>
        ) : (
          <Button
            size="sm"
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
      <ScreenFrame
        container={target}
        label={t('environment.region', { name: environment.name })}
        interactive={controlling}
      >
        {shaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-white">
            <p>{stopped ? t('environment.stopped') : t('environment.starting')}</p>
            {stopped && (
              <Button onClick={() => void fleet.environmentAction(environment.id, 'start')}>{t('action.start')}</Button>
            )}
          </div>
        )}
        {!shaded && oldImage && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 px-6 text-center text-sm text-white">
            {t('screen.restartEnvironment')}
          </div>
        )}
        {!shaded && !oldImage && screen.phase === 'offline' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-sm text-white">
            {t('environment.stopped')}
          </div>
        )}
        {!shaded && !oldImage && screen.phase !== 'live' && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-4 rounded bg-background/90 px-3 py-2 text-xs"
          >
            {t(`screen.phase.${screen.phase}`)}
          </div>
        )}
      </ScreenFrame>
      {screen.conflict && (
        <p role="alert" className="px-5 py-2 text-xs text-destructive">
          {t('screen.conflict')}
        </p>
      )}
      {screen.error && (
        <p role="alert" className="px-5 py-2 text-xs text-destructive">
          {fleetErrorText(screen.error, t)}
        </p>
      )}
      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        {controlling
          ? t('environment.footerControl', { name: environment.name })
          : t('environment.footerView', { name: environment.name })}
      </p>
    </div>
  )
}
