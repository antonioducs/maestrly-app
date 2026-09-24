import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetPendingInteraction, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { QuestionComposer } from '@/components/chat/QuestionComposer'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { fleetErrorMessage } from '@/lib/fleet/errors'

type Interaction = Extract<FleetTranscriptItem, { kind: 'permission' | 'question' | 'help' }>
export function InteractionCard({
  botId,
  item,
  fleet,
  onOpenScreen,
}: {
  botId: string
  item: Interaction
  fleet: FleetController
  onOpenScreen: () => void
}) {
  const { t } = useTranslation('fleet')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolve = async (id: string, resolution: Parameters<typeof fleet.resolve>[2]) => {
    setBusy(true)
    setError(null)
    try {
      await fleet.resolve(botId, id, resolution)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      {item.kind === 'permission' && (
        <>
          <div className="font-medium">{item.title}</div>
          {item.detail && (
            <code className="mt-2 block overflow-x-auto rounded bg-muted p-2 text-xs">{item.detail}</code>
          )}
          {item.state === 'pending' ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50"
                onClick={() => void resolve(item.requestId, { kind: 'permission', reply: 'once' })}
              >
                {t('interaction.approveOnce')}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50"
                onClick={() => void resolve(item.requestId, { kind: 'permission', reply: 'reject' })}
              >
                {t('interaction.deny')}
              </button>
            </div>
          ) : (
            <div className="mt-2 text-muted-foreground">{t(`interaction.${item.state}`)}</div>
          )}
        </>
      )}
      {item.kind === 'question' &&
        (item.state === 'pending' ? (
          <QuestionComposer
            questions={item.questions.map((question) => ({
              header: question.header ?? question.question,
              question: question.question,
              multiSelect: question.multiSelect,
              options: question.options.map((option) => ({
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
              })),
            }))}
            onSubmit={(answers) => void resolve(item.toolCallId, { kind: 'question', answers })}
            onDismiss={() => void resolve(item.toolCallId, { kind: 'question_dismiss' })}
          />
        ) : (
          <div>
            {t(`interaction.${item.state}`)}
            {item.answers && <span className="ml-2 text-muted-foreground">{item.answers.flat().join(', ')}</span>}
          </div>
        ))}
      {item.kind === 'help' && (
        <>
          <div className="font-medium">
            {t('interaction.needsYou', {
              name: fleet.state.snapshot.bots.find((bot) => bot.id === botId)?.name ?? botId,
            })}
          </div>
          <p className="mt-1 text-muted-foreground">{item.reason}</p>
          {item.state === 'pending' ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={onOpenScreen}
                className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground"
              >
                {t('interaction.openScreen')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolve(item.helpId, { kind: 'help', note: null })}
                className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50"
              >
                {t('interaction.resolved')}
              </button>
            </div>
          ) : (
            <span className="mt-2 block text-muted-foreground">{t('interaction.resolved')}</span>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export function pendingToTranscript(interaction: FleetPendingInteraction): Interaction {
  const base = { id: interaction.itemId, at: interaction.at }
  switch (interaction.kind) {
    case 'permission':
      return {
        ...base,
        kind: 'permission',
        requestId: interaction.id,
        title: interaction.title,
        detail: interaction.detail,
        state: 'pending',
        resolvedAt: null,
      }
    case 'question':
      return {
        ...base,
        kind: 'question',
        toolCallId: interaction.id,
        questions: interaction.questions,
        state: 'pending',
        answers: null,
      }
    case 'help':
      return {
        ...base,
        kind: 'help',
        helpId: interaction.id,
        reason: interaction.reason,
        state: 'pending',
        resolvedAt: null,
        note: null,
      }
  }
}
