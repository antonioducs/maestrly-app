import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { ChatQuestion } from '../../../shared/chat'

export function QuestionComposer({
  questions,
  onSubmit,
  onDismiss,
}: {
  questions: ChatQuestion[]
  onSubmit: (answers: string[][]) => void
  onDismiss: () => void
}) {
  const { t } = useTranslation('chat')
  const [tab, setTab] = useState(0) // 0..n-1 are questions; n is the confirmation tab.
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [free, setFree] = useState<Record<number, string>>({})
  const [freeOn, setFreeOn] = useState<Record<number, boolean>>({})
  const [focus, setFocus] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const freeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const isConfirm = tab >= questions.length
  const q = isConfirm ? null : questions[tab]
  const multi = !!q?.multiSelect
  const optCount = (q?.options.length ?? 0) + 1

  const answersFor = (qi: number): string[] => {
    const f = freeOn[qi] && free[qi]?.trim() ? [free[qi].trim()] : []
    return [...(picked[qi] ?? []), ...f]
  }
  const answered = (qi: number) => answersFor(qi).length > 0
  const allAnswered = questions.every((_, qi) => answered(qi))

  const submit = () => onSubmit(questions.map((_, qi) => answersFor(qi)))
  const goto = (tt: number) => {
    setTab(tt)
    setFocus(0)
  }

  const choose = (oi: number) => {
    if (!q) return
    if (oi === q.options.length) {
      setFreeOn((p) => ({ ...p, [tab]: true }))
      if (!multi) setPicked((p) => ({ ...p, [tab]: [] }))
      setTimeout(() => freeRef.current?.focus(), 0)
      return
    }
    const label = q.options[oi].label
    if (multi) {
      setPicked((p) => {
        const cur = p[tab] ?? []
        return { ...p, [tab]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      })
    } else {
      setPicked((p) => ({ ...p, [tab]: [label] }))
      setFreeOn((p) => ({ ...p, [tab]: false }))
    }
  }

  const advance = () => {
    if (isConfirm) {
      if (allAnswered) submit()
      return
    }
    goto(tab + 1)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onDismiss()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const total = questions.length + 1
      goto(e.shiftKey ? (tab - 1 + total) % total : (tab + 1) % total)
      return
    }
    const onFree = e.target === freeRef.current
    if (e.key === 'Enter') {
      e.preventDefault()
      if (onFree) {
        if (answered(tab)) advance()
        return
      }
      if (isConfirm) {
        if (allAnswered) submit()
        return
      }
      if (multi) {
        choose(focus)
      } else {
        choose(focus)
        if (focus < (q?.options.length ?? 0)) advance()
      }
      return
    }
    if (onFree) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocus((f) => (f + 1) % optCount)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocus((f) => (f - 1 + optCount) % optCount)
    }
  }

  const selectedLabels = (qi: number) => answersFor(qi)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-3">
      <div
        ref={rootRef}
        tabIndex={0}
        onKeyDown={onKey}
        className="rounded-xl border border-violet-500/30 bg-[#161618] p-3 outline-none focus:border-violet-500/50"
      >
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {questions.map((qq, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goto(i)}
              className={cn(
                'rounded px-2 py-0.5 text-[12px] transition-colors',
                tab === i
                  ? 'bg-violet-500/80 text-white'
                  : answered(i)
                    ? 'text-violet-300/80 hover:bg-white/5'
                    : 'text-muted-foreground hover:bg-white/5'
              )}
            >
              {qq.header}
            </button>
          ))}
          <button
            type="button"
            onClick={() => goto(questions.length)}
            className={cn(
              'rounded px-2 py-0.5 text-[12px] transition-colors',
              isConfirm ? 'bg-violet-500/80 text-white' : 'text-muted-foreground hover:bg-white/5'
            )}
          >
            {t('question.confirm')}
          </button>
        </div>

        {isConfirm ? (
          // Final summary and submission.
          <div className="flex flex-col gap-2">
            {questions.map((qq, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <span className="text-[12px] text-muted-foreground">{qq.question}</span>
                <span className="text-[13px] text-foreground">
                  {qq.isSecret && selectedLabels(i).length
                    ? '••••••'
                    : selectedLabels(i).join(', ') || (
                        <em className="text-muted-foreground/70">{t('question.noAnswer')}</em>
                      )}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="mb-2 text-[13px] font-medium text-foreground">
              {q!.question}
              {multi && (
                <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">{t('question.selectHint')}</span>
              )}
            </div>
            <div className="flex flex-col">
              {q!.options.map((o, oi) => {
                const sel = (picked[tab] ?? []).includes(o.label)
                const foc = focus === oi
                return (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => {
                      setFocus(oi)
                      choose(oi)
                    }}
                    className={cn(
                      'flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      foc ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
                    )}
                  >
                    <span className="select-none pt-0.5 text-[12px] text-muted-foreground">{oi + 1}.</span>
                    <span className="select-none pt-0.5 text-[12px] text-muted-foreground">
                      {multi ? (sel ? '[✓]' : '[ ]') : sel ? '◉' : '○'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('text-[13px]', sel ? 'text-violet-300' : 'text-foreground')}>{o.label}</span>
                      {o.description && (
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">{o.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}

              <button
                type="button"
                onClick={() => {
                  setFocus(q!.options.length)
                  choose(q!.options.length)
                }}
                className={cn(
                  'flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                  focus === q!.options.length ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
                )}
              >
                <span className="select-none pt-0.5 text-[12px] text-muted-foreground">{q!.options.length + 1}.</span>
                <span className="select-none pt-0.5 text-[12px] text-muted-foreground">
                  {multi ? (freeOn[tab] && free[tab]?.trim() ? '[✓]' : '[ ]') : freeOn[tab] ? '◉' : '○'}
                </span>
                <span className={cn('text-[13px]', freeOn[tab] ? 'text-violet-300' : 'text-foreground')}>
                  {t('question.typeYourOwn')}
                </span>
              </button>
              {freeOn[tab] && (
                <input
                  ref={freeRef}
                  type={q!.isSecret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  value={free[tab] ?? ''}
                  onChange={(e) => setFree((p) => ({ ...p, [tab]: e.target.value }))}
                  placeholder={t('question.freePlaceholder')}
                  className="ml-7 mt-1 rounded-md border border-violet-500/40 bg-black/30 px-2 py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-violet-500/70"
                />
              )}
            </div>
          </>
        )}

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
          <div className="hidden items-center gap-2 text-[11px] text-muted-foreground/70 sm:flex">
            <Kbd>tab</Kbd> {t('question.kbSwitch')} <Kbd>↑↓</Kbd> {t('question.kbSelect')} <Kbd>enter</Kbd>{' '}
            {isConfirm ? t('question.send').toLowerCase() : multi ? t('question.kbToggle') : t('question.kbConfirm')}{' '}
            <Kbd>esc</Kbd> {t('question.kbDismiss')}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground"
            >
              {t('question.dismiss')}
            </button>
            <button
              type="button"
              onClick={advance}
              disabled={isConfirm && !allAnswered}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium',
                isConfirm
                  ? allAnswered
                    ? 'bg-violet-500 text-white hover:bg-violet-400'
                    : 'bg-foreground/10 text-muted-foreground'
                  : 'bg-white/[0.06] text-foreground hover:bg-white/[0.1]'
              )}
            >
              {isConfirm ? t('question.send') : t('question.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-white/10 bg-white/5 px-1 py-px font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  )
}
