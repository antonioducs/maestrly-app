import { t, useLocale, errorText } from '../../i18n/index.js'
import { useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { api } from '../../app/api.js'

export function DeviceApproval() {
  useLocale()
  const initial = new URLSearchParams(location.search).get('user_code') ?? ''
  const [code, setCode] = useState(initial)
  const [request, setRequest] = useState<{ client_id?: string; scope?: string; resources?: string[] } | null>(null)
  const [message, setMessage] = useState('')
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  async function act(operation:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await operation()}catch(e){setError(e instanceof Error?e.message:'Could not save. Please try again.')}finally{setBusy(false)}}
  async function verify() {
    const normalized = code.trim().replaceAll('-', '').toUpperCase()
    setRequest(await api(`/api/auth/device?user_code=${encodeURIComponent(normalized)}`))
  }
  async function decide(decision: 'approve' | 'deny') {
    await api(`/api/auth/device/${decision}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userCode: code.trim().replaceAll('-', '').toUpperCase() }) })
    setMessage(decision === 'approve' ? "Device authorized." : "Authorization denied.")
  }
  return <main className="device-shell"><section className="device-card"><KeyRound /><p className="eyebrow">{t("Device authorization")}</p><h1>{t("Connect a client")}</h1>
    {!request ? <><label>{t("Code shown by the application")}<input value={code} onChange={(event) => setCode(event.target.value)} /></label><button className="primary" disabled={busy} onClick={() => void act(verify)}>{t("Review request")}</button></> : <><div className="authorization-subject"><ShieldCheck /><div><strong>{request.client_id ?? t("Maestrly client")}</strong><span>{t("Scopes ·")} {request.scope ?? 'profile'}</span><span>{t("Instance ·")} {location.origin}</span><span>{t("Resource ·")} {request.resources?.join(', ') ?? t("Maestrly API")}</span></div></div><p>{t("Authorize only a device in your possession. Never approve an unexpected code.")}</p><div className="dialog-actions"><button className="quiet" disabled={busy||!!message} onClick={() => void act(()=>decide('deny'))}>{t("Deny")}</button><button className="primary" disabled={busy||!!message} onClick={() => void act(()=>decide('approve'))}>{t("Authorize device")}</button></div></>}
    {error?<p role="alert" className="form-error">{errorText(error)}</p>:null}
    {message ? <p role="status">{t(message)}</p> : null}
  </section></main>
}
