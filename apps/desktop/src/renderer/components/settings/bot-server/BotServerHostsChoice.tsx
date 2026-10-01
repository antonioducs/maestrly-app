import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetInstallHosts } from '../../../../shared/fleet-installer'

export function BotServerHostsChoice({
  value,
  onChange,
}: {
  value: FleetInstallHosts
  onChange: (value: FleetInstallHosts) => void
}) {
  const { t } = useTranslation('fleet')
  const name = useId()
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 font-medium">{t('botServer.hosts.question')}</legend>
      {(['bots-and-artifacts', 'artifacts-only'] as const).map((choice) => (
        <label
          key={choice}
          className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface-elevated p-3 has-[:checked]:border-primary focus-within:ring-2 focus-within:ring-ring"
        >
          <input
            type="radio"
            name={name}
            value={choice}
            checked={value === choice}
            onChange={() => onChange(choice)}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">{t(`botServer.hosts.${choice}.title`)}</span>
            <span className="block text-xs text-muted-foreground">{t(`botServer.hosts.${choice}.description`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}
