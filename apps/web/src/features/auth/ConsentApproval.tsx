import { useEffect, useState } from 'react'
import { ShieldCheck, Plug } from 'lucide-react'
import { api } from '../../app/api.js'
import { t, useLocale, errorText } from '../../i18n/index.js'

interface PublicClient {
  client_id?: string
  client_name?: string
  client_uri?: string
  logo_uri?: string
}

/** What each scope actually allows, in words a person can judge. */
const scopeText: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'Read your name',
  email: 'Read your email address',
  offline_access: 'Stay connected without asking you again',
  'api:read': 'Read what you can read in Maestrly',
  'api:write': 'Act on your behalf in Maestrly',
}

export function ConsentApproval() {
  useLocale()
  const [params] = useState(() => new URLSearchParams(location.search))
  const clientId = params.get('client_id') ?? ''
  const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean)
  const resources = params.getAll('resource')
  const [client, setClient] = useState<PublicClient | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

  useEffect(() => {
    if (!clientId) {
      setError('This authorization link is incomplete. Start again from the application.')
      return
    }
    void api<PublicClient>(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)
      .then(setClient)
      .catch((e: Error) => setError(e.message))
  }, [clientId])

  async function decide(accept: boolean) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api<{ redirect_uri?: string }>('/api/auth/oauth2/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The signed query is echoed back unchanged: the server, not this page, decides what was requested.
        body: JSON.stringify({ accept, oauth_query: location.search.replace(/^\?/, '') }),
      })
      if (result.redirect_uri) {
        location.assign(result.redirect_uri)
        return
      }
      setDone(accept ? 'Access authorized.' : 'Authorization denied.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="device-shell">
      <section className="device-card">
        <Plug />
        <p className="eyebrow">{t('Authorization request')}</p>
        <h1>{t('Connect an application')}</h1>
        <div className="authorization-subject">
          <ShieldCheck />
          <div>
            <strong>{client?.client_name || clientId || t('Unknown application')}</strong>
            <span>
              {t('Instance ·')} {location.origin}
            </span>
            {resources.length ? (
              <span>
                {t('Resource ·')} {resources.join(', ')}
              </span>
            ) : null}
            {client?.client_uri ? <span>{client.client_uri}</span> : null}
          </div>
        </div>
        <ul className="consent-scopes">
          {scopes.map((scope) => (
            <li key={scope}>{scopeText[scope] ? t(scopeText[scope]) : scope}</li>
          ))}
        </ul>
        <p>
          {t(
            'This application will act with your access, limited to what you grant it. You can revoke it at any time in Connectors.'
          )}
        </p>
        <div className="dialog-actions">
          <button className="quiet" disabled={busy || !!done} onClick={() => void decide(false)}>
            {t('Deny')}
          </button>
          <button className="primary" disabled={busy || !!done || !clientId} onClick={() => void decide(true)}>
            {t('Authorize application')}
          </button>
        </div>
        {error ? (
          <p role="alert" className="form-error">
            {errorText(error)}
          </p>
        ) : null}
        {done ? <p role="status">{t(done)}</p> : null}
      </section>
    </main>
  )
}
