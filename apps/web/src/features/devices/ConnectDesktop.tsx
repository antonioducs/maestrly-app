import { useEffect, useState } from 'react'
import { api } from '../../app/api.js'
import { t } from '../../i18n/index.js'
export function ConnectDesktop() {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true
    void api<{ canonicalUrl: string }>('/api/v1/meta')
      .then((meta) => {
        if (active) setUrl(meta.canonicalUrl)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  return (
    <details className="connect-desktop">
      <summary>{t('Connect my desktop')}</summary>
      <ol>
        <li>{t('Open Maestrly desktop → Settings → Platform connections.')}</li>
        <li>
          {t('Add this instance and connect with the same account as the web.')}
          {url ? (
            <input aria-label={t('Instance URL')} readOnly value={url} onFocus={(e) => e.target.select()} />
          ) : null}
        </li>
        <li>{t('Check the pairing code in the browser and approve access.')}</li>
        <li>{t('Bind this project to a local workspace and enable personal execution.')}</li>
      </ol>
      <p className="form-note">
        {t('Only you can request work on your device. No incoming port or webhook is required.')}
      </p>
    </details>
  )
}
