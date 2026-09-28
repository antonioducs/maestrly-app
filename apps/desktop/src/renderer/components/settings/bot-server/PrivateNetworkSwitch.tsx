import { useTranslation } from 'react-i18next'
import { SettingsSwitch } from '@/components/fleet/SettingsSwitch'

export function PrivateNetworkSwitch({
  mode,
  checked,
  onChange,
  disabled,
}: {
  mode: 'local' | 'remote'
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('fleet')
  const label = t(`botServer.privateNetwork.${mode}Label`)
  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <SettingsSwitch checked={checked} label={label} disabled={disabled} onChange={() => onChange(!checked)} />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t(`botServer.privateNetwork.${mode}Help`)}</p>
    </div>
  )
}
