import { useEffect, useState } from 'react'
import { Monitor, ShieldCheck } from 'lucide-react'
import type { PersonalDevice } from '@maestrly/protocol'
import { api, write } from '../../app/api.js'
import { t, useLocale, errorText, dateTime } from '../../i18n/index.js'
import { FormDialog } from '../../components/FormDialog.js'
import { ConnectDesktop } from './ConnectDesktop.js'
import { EmptyState } from '../../components/EmptyState.js'
export function PersonalDevicesPanel({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  useLocale()
  const [devices, setDevices] = useState<PersonalDevice[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [revoking, setRevoking] = useState<PersonalDevice | null>(null)
  useEffect(() => {
    let active = true
    const load = () =>
      void api<PersonalDevice[]>(`/api/v1/organizations/${organizationId}/projects/${projectId}/personal-devices`)
        .then((value) => {
          if (active) {
            setDevices(value)
            setError('')
            setLoading(false)
          }
        })
        .catch((e) => {
          if (active) {
            setError(e.message)
            setLoading(false)
          }
        })
    load()
    const timer = setInterval(load, 15000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [organizationId, projectId, refresh])
  return (
    <section className="settings-panel personal-devices">
      <header>
        <Monitor />
        <div>
          <p className="eyebrow">{t('Personal execution')}</p>
          <h2>{t('My computers')}</h2>
        </div>
      </header>
      <p className="form-note">
        <ShieldCheck size={15} />{' '}
        {t('These devices accept only your explicit requests. They are not available to the team runner pool.')}
      </p>
      <div className="personal-toolbar">
        <button className="quiet" onClick={() => setRefresh((n) => n + 1)}>
          {t('Refresh computers')}
        </button>
      </div>
      {loading ? <p role="status">{t('Loading…')}</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {errorText(error)}
        </p>
      ) : null}
      <div className="personal-device-list">
        {devices.map((device) => (
          <article key={device.id}>
            <Monitor size={22} />
            <div>
              <h3>{device.name}</h3>
              <p className="state-chip">
                {t(!device.enabled ? 'Personal execution disabled' : device.online ? 'Online' : 'Offline')}
              </p>
              <p className="form-note">
                {t('Last seen')}: {device.lastSeenAt ? dateTime(device.lastSeenAt) : '—'}
              </p>
              <p>
                {device.capabilities?.models.map((m) => m.label).join(' · ') ||
                  t('No executor model available on this device.')}
              </p>
              {device.capabilities?.issues.map((issue) => (
                <p className="form-note" key={issue}>
                  {errorText(issue)}
                </p>
              ))}
            </div>
            <button className="quiet" onClick={() => setRevoking(device)}>
              {t('Disconnect computer')}
            </button>
          </article>
        ))}
      </div>
      {!loading && !devices.length ? (
        <EmptyState title={t('No personal computer connected for this project.')}>
          <p>{t('Open Maestrly desktop to execute on your computer.')}</p>
        </EmptyState>
      ) : null}
      <ConnectDesktop />
      {revoking ? (
        <FormDialog
          title={t('Disconnect computer')}
          submitLabel={t('Disconnect computer')}
          onClose={() => setRevoking(null)}
          onSubmit={async () => {
            await write(`/api/v1/organizations/${organizationId}/personal-devices/${revoking.id}/revoke`, 'POST', {})
            setRefresh((n) => n + 1)
          }}
        >
          <p>{revoking.name}</p>
          <p>
            {t(
              'Pending work for this computer will be cancelled and active work will be stopped. Enable it again in the desktop to reconnect.'
            )}
          </p>
        </FormDialog>
      ) : null}
    </section>
  )
}
