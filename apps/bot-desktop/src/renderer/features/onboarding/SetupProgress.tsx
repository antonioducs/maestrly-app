import { AttachAccount } from '../accounts/AttachAccount'
import { Button } from '../../ui'
import { useEffect, useState } from 'react'
import type { Bot, BotOperation } from '@maestrly/host-protocol'
import type { OnboardingDraft } from '../../../shared/types'
import { useT } from '../../i18n'
export function SetupProgress({
  draft,
  onReady,
  startOver,
  onAccounts,
}: {
  draft: OnboardingDraft
  onReady: (bot: Bot) => void
  startOver: () => void
  onAccounts: () => void
}) {
  const t = useT()
  const [operation, setOperation] = useState<BotOperation>()
  const [error, setError] = useState('')
  const inspectBot = async (botId: string) => {
    const bot = await window.bot.bot({ method: 'bot.inspect', params: { botId } })
    if (bot.status === 'ready') onReady(bot)
  }
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await window.bot.bot({ method: 'bot.setup.inspect', params: { operationId: draft.operationId } })
        if (!active) return
        setOperation(next)
        if (next.status === 'succeeded' && next.botId) await inspectBot(next.botId)
        if (active && !['failed', 'cancelled', 'succeeded'].includes(next.status)) timer = setTimeout(poll, 750)
      } catch (error) {
        if (active) setError(String(error))
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [draft.operationId])
  return (
    <section className="onboarding">
      <h1>{t('creatingBot')}</h1>
      {operation && (
        <ol className="setup-steps">
          {operation.steps.filter(step => step.id !== 'account' && step.id !== 'computer').map((step) => (
            <li key={step.id} data-state={step.status}>
              <span>{step.label}</span> <small>{t(step.status === 'failed' ? 'failed' : step.status)}</small>
              {step.error && <p>{step.error.message}</p>}
            </li>
          ))}
        </ol>
      )}
      {operation?.error && <p role="alert">{operation.error.message}</p>}
      {error && (
        <>
          <p role="alert">
            {t('setupMissing')} {error}
          </p>
          <Button onClick={startOver}>{t('startOver')}</Button>
        </>
      )}
      {operation?.status === 'waiting_user' &&
        operation.steps.some((step) => step.id === 'account' && step.status === 'waiting_user') &&
        operation.botId && (
          <AttachAccount botId={operation.botId} onAccounts={onAccounts} onDone={() => void inspectBot(operation.botId!)} />
        )}
    </section>
  )
}
