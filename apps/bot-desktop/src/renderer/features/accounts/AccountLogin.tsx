import { Button, Input } from '../../ui'
import { useEffect, useRef, useState } from 'react'
import type { AuthStatus } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import { mergeLoginStatus } from '../onboarding/login-state'
export function AccountLogin({ accountId, onConnected }: { accountId: string; onConnected: () => void }) {
  const t = useT()
  const [auth, setAuth] = useState<AuthStatus>()
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const mutating = useRef(false)
  useEffect(() => {
    const token = ++generation.current
    mutating.current = false
    setAuth(undefined)
    setError('')
    setBusy(false)
    let alive = true
    let polling = false
    const poll = async () => {
      setAuth(previous => previous?.state === 'connecting' ? mergeLoginStatus(previous, previous, Date.now()) : previous)
      if (polling || mutating.current) return
      polling = true
      const revision = generation.current
      try {
        const account = await window.bot.bot({ method: 'account.inspect', params: { accountId } })
        const next = account.status
        if (!account.available && account.issue && alive) setError(account.issue)
        if (!alive || revision !== generation.current) return
        setAuth(previous => mergeLoginStatus(previous, next, Date.now()))
        if (next.state === 'connected') onConnected()
      } catch (error) {
        if (alive && revision === generation.current) setError(String(error))
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      alive = false
      if (generation.current >= token) generation.current++
      clearInterval(timer)
    }
  }, [accountId])
  const openLoginPage = async (url: string) => {
    if (!(await window.bot.openExternal(url))) throw new Error(t('loginOpenFailed'))
  }
  const login = async (apiKey = false) => {
    const token = ++generation.current
    mutating.current = true
    setBusy(true)
    setError('')
    try {
      const submittedKey = key
      setKey('')
      const account = apiKey
        ? await window.bot.bot({ method: 'account.setApiKey', params: { accountId, apiKey: submittedKey } })
        : await window.bot.bot({ method: 'account.start', params: { accountId } })
      const next = account.status
      if (token !== generation.current) return
      setAuth(next)
      setKey('')
      if (!apiKey && next.state === 'connecting' && next.pending) await openLoginPage(next.pending.verificationUrl)
      if (next.state === 'connected') onConnected()
    } catch (error) {
      if (token === generation.current) setError(String(error))
    } finally {
      if (token === generation.current) { mutating.current = false; setBusy(false) }
    }
  }
  const cancelLogin = async () => {
    const token = ++generation.current
    mutating.current = true
    setBusy(true)
    setError('')
    try {
      const next = (await window.bot.bot({ method: 'account.cancel', params: { accountId } })).status
      if (token === generation.current) setAuth(next)
    } catch (error) {
      if (token === generation.current) setError(String(error))
    } finally {
      if (token === generation.current) { mutating.current = false; setBusy(false) }
    }
  }
  return (
    <section className="account-login">
      <p>{t('globalAccountExplanation')}</p>
      {auth?.state === 'incompatible' && <p role="alert">{auth.incompatibleReason ?? t('incompatible')}</p>}
      {auth?.state === 'expired' && <p role="alert">{auth.incompatibleReason ?? t('expired')}</p>}
      {auth?.pending && auth.state === 'connecting' ? (
        <>
          <p className="device-code" aria-label={t('loginCode')}>{auth.pending.userCode}</p>
          <p>{t('loginPending')}</p>
          <Button className="primary" onClick={() => void openLoginPage(auth.pending!.verificationUrl).catch(error => setError(String(error)))}>
            {t('loginPage')}
          </Button>
          <Button disabled={busy} onClick={() => void cancelLogin()}>
            {t('cancelLogin')}
          </Button>
        </>
      ) : (
        <Button className="primary" disabled={busy} onClick={() => void login()}>
          {t('login')}
        </Button>
      )}
      <details>
        <summary>{t('apiKey')}</summary>
        <p>{t('keyBilling')}</p>
        <label>
          {t('key')}
          <Input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} />
        </label>
        <Button disabled={busy || auth?.state === 'connecting' || key.length < 8} onClick={() => void login(true)}>
          {t('connectKey')}
        </Button>
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
