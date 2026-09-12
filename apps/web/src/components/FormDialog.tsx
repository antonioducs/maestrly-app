import { t, useLocale, errorText } from '../i18n/index.js'
import { useEffect, useId, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { X } from 'lucide-react'

export function FormDialog({ title, submitLabel, onClose, onSubmit, children, submitDisabled=false }: {
  title: string
  submitLabel: string
  onClose(): void
  onSubmit(data: FormData): Promise<void>
  submitDisabled?:boolean
  children: ReactNode
}) {
  useLocale()
  const dialog = useRef<HTMLDialogElement>(null)
  const locked = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    element.querySelector<HTMLElement>('input, textarea')?.focus()
    return () => { element.close(); previous?.focus() }
  }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked.current||submitDisabled) return
    const data = new FormData(event.currentTarget)
    locked.current = true
    setBusy(true); setError('')
    try { await onSubmit(data); onClose() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save. Please try again.") }
    finally { locked.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="form-dialog" aria-labelledby={titleId}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]')).filter(element => !element.matches(':disabled') && element.tabIndex >= 0)
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}
    onCancel={(event) => { event.preventDefault(); if (!locked.current) onClose() }}>
    <form onSubmit={submit} aria-busy={busy}>
      <header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label={t("Close dialog")} disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <fieldset disabled={busy}>{children}</fieldset>
      {error ? <p className="form-error" role="alert">{errorText(error)}</p> : null}
      <footer className="dialog-actions"><button type="button" className="quiet" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button type="submit" className="primary" disabled={busy||submitDisabled}>{busy ? t("Saving…") : submitLabel}</button></footer>
    </form>
  </dialog>
}
