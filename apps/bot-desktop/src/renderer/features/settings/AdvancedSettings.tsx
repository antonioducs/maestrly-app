import { Button } from '../../ui'
import { useState } from 'react'
import type { Connection } from '../../../shared/types'
import { useT } from '../../i18n'
import { useAdminT } from '../../i18n/admin'
export function AdvancedSettings({ computers }: { computers: () => void }) {
  const t = useT()
  const a = useAdminT()
  const [status, setStatus] = useState<Connection>()
  const [error, setError] = useState('')
  return (
    <section>
      <h2>{t('advanced')}</h2>
      <Button onClick={computers}>{t('computers')}</Button>
      <details
        onToggle={(event) => {
          if (event.currentTarget.open)
            void window.bot
              .status()
              .then(setStatus)
              .catch((error) => setError(String(error)))
        }}
      >
        <summary>{t('diagnostics')}</summary>
        {status && (
          <>
            <pre>{JSON.stringify(status, null, 2)}</pre>
            {status.recoveryIssue && <p role="alert">{status.recoveryIssue}</p>}
            {status.retryableKeys?.map((key) => (
              <Button
                key={key}
                onClick={() =>
                  void window.bot
                    .retry(key)
                    .then(() => window.bot.status())
                    .then(setStatus)
                    .catch((error) => setError(String(error)))
                }
              >
                {a('Retry same request')}
              </Button>
            ))}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </details>
    </section>
  )
}
