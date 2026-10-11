import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetInstallHosts, FleetInstallRecord, FleetInstallRemoteInput } from '../../../../shared/fleet-installer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { validateRemoteForm, type RemoteForm } from '@/lib/fleet/installer'
import { BotServerHostsChoice } from './BotServerHostsChoice'
import { PrivateNetworkSwitch } from './PrivateNetworkSwitch'

export function BotServerRemoteSetup({
  record,
  defaultHosts = 'bots-and-artifacts',
  onBack,
  onInstall,
}: {
  record?: FleetInstallRecord | null
  defaultHosts?: FleetInstallHosts
  onBack: () => void
  onInstall: (input: FleetInstallRemoteInput) => void
}) {
  const { t } = useTranslation('fleet')
  const [form, setForm] = useState<RemoteForm>({
    host: record?.remote?.host ?? '',
    port: String(record?.remote?.port ?? 22),
    username: record?.remote?.username ?? 'root',
    password: '',
    useKey: false,
    privateKey: '',
  })
  const [passphrase, setPassphrase] = useState('')
  const [hosts, setHosts] = useState<FleetInstallHosts>(defaultHosts)
  const [deviceName, setDeviceName] = useState(t(`settings.deviceNameDefault.${window.api.platformInfo.os}`))
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(record?.allowPrivateNetwork ?? false)
  const [advanced, setAdvanced] = useState(false)
  const [errors, setErrors] = useState<ReturnType<typeof validateRemoteForm>>({})
  const [fileError, setFileError] = useState(false)
  const change = (field: keyof RemoteForm, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
  }
  const install = () => {
    const nextErrors = validateRemoteForm(form)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    onInstall({
      target: { host: form.host.trim(), port: Number(form.port), username: form.username.trim() },
      credentials: form.useKey
        ? { kind: 'key', privateKey: form.privateKey, passphrase: passphrase || null }
        : { kind: 'password', password: form.password },
      deviceName: deviceName.trim() || t(`settings.deviceNameDefault.${window.api.platformInfo.os}`),
      allowPrivateNetwork,
      hosts,
    })
  }
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        {t('botServer.back')}
      </Button>
      <h3 className="text-base font-semibold">{t('botServer.choice.remoteTitle')}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('botServer.remote.requirements')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1">
          <span>{t('botServer.remote.host')}</span>
          <Input
            className="bg-surface-elevated"
            value={form.host}
            onChange={(event) => change('host', event.target.value)}
            autoComplete="url"
            aria-invalid={!!errors.host}
          />
          {errors.host && <span className="text-xs text-destructive">{t(errors.host)}</span>}
        </label>
        <label className="block space-y-1">
          <span>{t('botServer.remote.username')}</span>
          <Input
            className="bg-surface-elevated"
            value={form.username}
            onChange={(event) => change('username', event.target.value)}
            autoComplete="username"
            aria-invalid={!!errors.username}
          />
          {errors.username && <span className="text-xs text-destructive">{t(errors.username)}</span>}
        </label>
      </div>
      {!form.useKey && (
        <label className="block space-y-1">
          <span>{t('botServer.remote.password')}</span>
          <Input
            className="bg-surface-elevated"
            type="password"
            value={form.password}
            onChange={(event) => change('password', event.target.value)}
            autoComplete="off"
            aria-invalid={!!errors.password}
          />
          {errors.password && <span className="text-xs text-destructive">{t(errors.password)}</span>}
        </label>
      )}
      <Button variant="link" className="px-0" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        {t('botServer.remote.advanced')}
      </Button>
      {advanced && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <label className="block space-y-1">
            <span>{t('botServer.remote.port')}</span>
            <Input
              className="bg-surface-elevated"
              inputMode="numeric"
              value={form.port}
              onChange={(event) => change('port', event.target.value)}
              aria-invalid={!!errors.port}
            />
            {errors.port && <span className="text-xs text-destructive">{t(errors.port)}</span>}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.useKey} onChange={(event) => change('useKey', event.target.checked)} />
            {t('botServer.remote.useKey')}
          </label>
          {form.useKey && (
            <>
              <label className="block space-y-1">
                <span>{t('botServer.remote.privateKey')}</span>
                <textarea
                  className="min-h-28 w-full rounded-md border border-input bg-surface-elevated p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={form.privateKey}
                  onChange={(event) => change('privateKey', event.target.value)}
                  spellCheck={false}
                  aria-invalid={!!errors.privateKey}
                />
                {errors.privateKey && <span className="text-xs text-destructive">{t(errors.privateKey)}</span>}
              </label>
              <label className="block text-xs">
                <span className="mb-1 block">{t('botServer.remote.chooseFile')}</span>
                <input
                  type="file"
                  className="block w-full text-xs"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    const reader = new FileReader()
                    reader.onload = () => {
                      change('privateKey', String(reader.result ?? ''))
                      setFileError(false)
                    }
                    reader.onerror = () => setFileError(true)
                    reader.readAsText(file)
                  }}
                />
                {fileError && <span className="text-destructive">{t('botServer.remote.fileError')}</span>}
              </label>
              <label className="block space-y-1">
                <span>{t('botServer.remote.passphrase')}</span>
                <Input
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  autoComplete="off"
                />
              </label>
            </>
          )}
        </div>
      )}
      <p className="rounded-lg border border-amber-500/40 p-3 text-xs leading-relaxed text-amber-500">
        {t('botServer.remote.adminKey')}
      </p>
      <label className="block space-y-1">
        <span>{t('settings.deviceName')}</span>
        <Input
          className="bg-surface-elevated"
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          maxLength={80}
        />
      </label>
      <BotServerHostsChoice value={hosts} onChange={setHosts} />
      <PrivateNetworkSwitch mode="remote" checked={allowPrivateNetwork} onChange={setAllowPrivateNetwork} />
      <Button onClick={install}>{t('botServer.remote.install')}</Button>
    </div>
  )
}
