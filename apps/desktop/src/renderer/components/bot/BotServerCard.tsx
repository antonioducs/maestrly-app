import { useTranslation } from 'react-i18next'
import { Copy, Server } from 'lucide-react'
import type { BotServerView } from '../../../shared/bot'
import { Button } from '../ui/button'
import { Pill, type PillTone } from './pill'
import { defaultServer, endpointOf, inputClass, localOnly, type ServerDraft } from './config'

interface Props {
  config: ServerDraft
  state: BotServerView['state']
  dirty: boolean
  busy: boolean
  copied: boolean
  onEdit: (patch: Partial<ServerDraft>) => void
  onSave: () => void
  onDiscard: () => void
  onCopy: (address: string) => void
}

const TONES: Record<BotServerView['state'], PillTone> = {
  listening: 'ok',
  starting: 'warn',
  error: 'danger',
  stopped: 'off',
}

/**
 * The connection this computer offers. The address a bot dials is configuration, so it is edited and
 * saved here, and the endpoint shown is the one a bot must actually be pointed at, path included.
 */
export function BotServerCard({ config, state, dirty, busy, copied, onEdit, onSave, onDiscard, onCopy }: Props) {
  const { t } = useTranslation('ui')
  const endpoint = endpointOf(config)
  const typedAddress = config.publicUrl.trim()
  const addressUnusable = typedAddress.length > 0 && localOnly(typedAddress)

  return (
    <form
      className="space-y-4 rounded-xl border border-border p-4"
      data-testid="bot-server"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Server className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t('bots.server')}</h3>
        <Pill tone={TONES[state]} testId="bot-server-status">
          {t(`bots.serverStates.${state}`)}
        </Pill>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('bots.serverDescription')}</p>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) => onEdit({ enabled: event.target.checked })}
        />
        <span>{t('bots.serverEnabled')}</span>
      </label>

      <label className="block space-y-1.5 text-xs text-muted-foreground">
        <span>{t('bots.serverPublicUrl')}</span>
        <input
          className={inputClass}
          value={config.publicUrl}
          placeholder="https://bot.example.com"
          onChange={(event) => onEdit({ publicUrl: event.target.value })}
        />
        {addressUnusable && (
          <span data-testid="bot-server-address-error" className="block text-destructive">
            {t('bots.publicUrlInvalid')}
          </span>
        )}
      </label>

      <p
        data-testid="bot-server-warning"
        className="rounded-md border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs leading-relaxed text-amber-200"
      >
        {t('bots.internetWarning')}
      </p>
      {localOnly(endpoint) && !addressUnusable && (
        <p className="text-xs leading-relaxed text-muted-foreground">{t('bots.localOnly')}</p>
      )}

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t('bots.advanced')}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span>{t('bots.serverHost')}</span>
            <input
              className={inputClass}
              value={config.host}
              placeholder={defaultServer.host}
              onChange={(event) => onEdit({ host: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5">
            <span>{t('bots.serverPort')}</span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={65535}
              value={config.port}
              onChange={(event) => onEdit({ port: Number(event.target.value) })}
            />
          </label>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-black/20 p-3 text-xs">
        <span className="text-muted-foreground">{t('bots.endpoint')}</span>
        <code data-testid="bot-server-endpoint" className="min-w-0 flex-1 select-all break-all">
          {endpoint}
        </code>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onCopy(endpoint)}>
          <Copy className="size-3.5" />
          {copied ? t('bots.copied') : t('bots.copyEndpoint')}
        </Button>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {dirty && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDiscard}>
            {t('bots.discard')}
          </Button>
        )}
        <Button type="submit" disabled={busy || !dirty}>
          {busy ? t('bots.working') : t('bots.saveServer')}
        </Button>
      </div>
    </form>
  )
}
