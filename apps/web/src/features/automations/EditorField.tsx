import type { ReactNode } from 'react'

export type HintTone = '' | 'warn' | 'good'

/**
 * Field with a reserved hint line. Nothing in the editor is mounted or unmounted on selection:
 * controls become disabled and the hint explains why, so the layout never shifts.
 */
export function Field({
  label,
  htmlFor,
  hint,
  tone = '',
  wide = false,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  tone?: HintTone
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={'af-field' + (wide ? ' af-wide' : '')}>
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="af-label">{label}</span>}
      {children}
      <p className={'af-hint' + (tone ? ' ' + tone : '')}>{hint ?? ''}</p>
    </div>
  )
}

export function Section({
  number,
  title,
  description,
  actions,
  children,
}: {
  number: string
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="af-sec" aria-label={title}>
      <header className="af-sec-head">
        <span className="af-num">{number}</span>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {actions ? <div className="af-sec-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}
