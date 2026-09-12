import { t, useLocale, errorText } from '../../i18n/index.js'
import { useEffect, useState, type FormEvent } from 'react'
import { UserPlus } from 'lucide-react'
import { api, write } from '../../app/api.js'
import { Login } from './Login.js'
export function Invitation() {
  useLocale()
  const query = new URLSearchParams(location.search)
  const organizationId = query.get('organization') ?? '',
    email = query.get('email') ?? '',
    token = query.get('token') ?? ''
  const [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [valid, setValid] = useState<boolean | null>(null),
    [mode, setMode] = useState<'register' | 'login'>('register'),
    [accountCreated, setAccountCreated] = useState(false)
  const [session, setSession] = useState<{ user: { email: string } } | null>(null)
  const refresh = () => api<{ user: { email: string } } | null>('/api/auth/get-session').then(setSession)
  useEffect(() => {
    let active = true
    void api<{ valid: boolean }>('/api/v1/invitations/inspect', {
      method: 'POST',
      body: JSON.stringify({ organizationId, email, token }),
    })
      .then((r) => {
        if (active) setValid(r.valid === true)
      })
      .catch((e) => {
        if (active) {
          setValid(false)
          setError(e.message)
        }
      })
    void refresh().catch(() => {})
    return () => {
      active = false
    }
  }, [organizationId, email, token])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (session) await write('/api/v1/invitations/accept', 'POST', { organizationId, email, token })
      else {
        await write('/api/v1/invitations/register', 'POST', { organizationId, email, token, name, password })
        setAccountCreated(true)
        try {
          await api('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }) })
        } catch {
          setMode('login')
          setError('Account created. Sign in to continue.')
          return
        }
      }
      location.assign('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invitation could not be accepted.')
    } finally {
      setBusy(false)
    }
  }
  if (mode === 'login')
    return (
      <>
        <div className="invitation-login-note">
          <p>
            {t('Sign in with the invited email first.')} {email}
          </p>
          <button className="quiet" onClick={() => setMode('register')}>
            {t('Back to invitation')}
          </button>
          {error ? <p role="alert">{errorText(error)}</p> : null}
        </div>
        <Login
          onSignedIn={() => {
            if (accountCreated) location.assign('/')
            else
              void refresh().then(() => {
                setMode('register')
                setError('')
              })
          }}
        />
      </>
    )
  return (
    <main className="device-shell">
      <form className="device-card" onSubmit={submit}>
        <UserPlus />
        <p className="eyebrow">{t('Team invitation')}</p>
        <h1>{t('Join this instance')}</h1>
        {valid === null ? (
          <p role="status">{t('Loading…')}</p>
        ) : valid === false ? (
          <p role="alert" className="form-error">
            {t('Invitation is invalid, expired, or already used.')}
          </p>
        ) : (
          <>
            <label>
              {t('Email')}
              <input value={email} readOnly />
            </label>
            {session ? (
              <>
                <p>
                  {t('Signed in as')}: {session.user.email}
                </p>
                {session.user.email.toLowerCase() === email.toLowerCase() ? (
                  <button className="primary" disabled={busy}>
                    {t('Accept invitation')}
                  </button>
                ) : (
                  <>
                    <p>{t('Sign in with the invited email first.')}</p>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() =>
                        void api('/api/auth/sign-out', { method: 'POST' })
                          .then(() => {
                            setSession(null)
                            setMode('login')
                          })
                          .catch((e) => setError(e.message))
                      }
                    >
                      {t('Use another account')}
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <label>
                  {t('Your name')}
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={160}
                    disabled={busy}
                  />
                </label>
                <label>
                  {t('Create password')}
                  <input
                    type="password"
                    minLength={12}
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </label>
                <button className="primary" disabled={busy}>
                  {busy ? t('Saving…') : t('Create local account')}
                </button>
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => {
                    setMode('login')
                    setError('')
                  }}
                >
                  {t('Already have an account? Sign in')}
                </button>
              </>
            )}
            <p className="form-note">
              {t(
                'This one-use invitation grants only the role chosen by the administrator. No role is accepted from this form.'
              )}
            </p>
          </>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {errorText(error)}
          </p>
        ) : null}
      </form>
    </main>
  )
}
