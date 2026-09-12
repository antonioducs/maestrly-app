import { t, useLocale, errorText } from '../../i18n/index.js'
import { useState, type FormEvent } from 'react'
import { ArrowRight, KeyRound } from 'lucide-react'
import { api } from '../../app/api.js'

export function Login({ onSignedIn }: { onSignedIn(): void }) {
  useLocale()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      await api('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }), headers: { 'content-type': 'application/json' } })
      onSignedIn()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.")
    } finally { setBusy(false) }
  }

  return <main className="login-shell">
    <div className="login-atmosphere" aria-hidden="true" />
    <section className="login-mark" aria-label={t("About Maestrly")}>
      <img className="brand-symbol" src="/brand/mark-full.svg" alt="Maestrly" />
      <p className="eyebrow">{t("Maestrly")}</p>
      <h1>{t("Your workspace, connected.")}</h1>
      <p className="login-copy">{t("Organize work, run agents and review results in one place.")}</p>
    </section>
    <form className="login-card" onSubmit={submit}>
      <KeyRound size={22} aria-hidden="true" />
      <div><p className="eyebrow">{t("Your instance")}</p><h2>{t("Sign in")}</h2></div>
      <label>{t("Email")}<input autoFocus required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
      <label>{t("Password")}<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
      {error ? <p className="form-error" role="alert">{errorText(error)}</p> : null}
      <button className="primary" disabled={busy}>{busy ? t("Signing in…") : t("Sign in")} <ArrowRight size={17} /></button>
      <p className="form-note">{t("Accounts are managed by this installation. Public sign-up is off by default.")}</p>
    </form>
  </main>
}
