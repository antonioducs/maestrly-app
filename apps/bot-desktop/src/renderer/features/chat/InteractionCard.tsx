import { Button, Input } from '../../ui'
import { useState } from 'react'
import type { BotInteraction } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
export function InteractionCard({
  interaction,
  refresh,
  disabled,
}: {
  interaction: BotInteraction
  refresh: () => Promise<void>
  disabled: boolean
}) {
  const t = useT()
  const [answer, setAnswer] = useState('')
  const [parametersOpen, setParametersOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const resolve = async (decision: 'approve' | 'deny' | 'answer') => {
    setBusy(true)
    try {
      await window.bot.bot({
        method: 'bot.interactions.resolve',
        params: {
          interactionId: interaction.id,
          expectedGeneration: interaction.generation,
          decision,
          ...(decision === 'answer' ? { answer } : {}),
        },
      })
    } catch (error) {
      setError(String(error))
    } finally {
      await refresh()
      setBusy(false)
    }
  }
  return (
    <article className="interaction">
      <h3>{interaction.title}</h3>
      <p>{interaction.reason}</p>
      <p>{interaction.consequence}</p>
      {interaction.kind === 'question' ? (
        <>
          <label>
            {t('answer')}
            <Input value={answer} onChange={(event) => setAnswer(event.target.value)} />
          </label>
          <Button disabled={disabled || busy || !answer.trim()} onClick={() => void resolve('answer')}>
            {t('respond')}
          </Button>
        </>
      ) : (
        <div className="actions">
          <Button disabled={disabled || busy} onClick={() => void resolve('approve')}>
            {t('allow')}
          </Button>
          <Button disabled={disabled || busy} onClick={() => void resolve('deny')}>
            {t('deny')}
          </Button>
        </div>
      )}
      <details onToggle={(event) => setParametersOpen(event.currentTarget.open)}>
        <summary>{t('parameters')}</summary>
        {parametersOpen && <pre>{JSON.stringify(interaction.parameters, null, 2)}</pre>}
      </details>
      {error && <p role="alert">{error}</p>}
    </article>
  )
}
