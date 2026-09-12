import { useTranslation } from 'react-i18next'
import { MessageCircleQuestion } from 'lucide-react'
import { toolOutputText, type ChatQuestion, type MessagePart } from '../../../shared/chat'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

export function QuestionCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation('chat')
  const questions = (((part.input as { questions?: unknown })?.questions as ChatQuestion[] | undefined) ?? []).filter(
    (q): q is ChatQuestion => !!q && Array.isArray(q.options)
  )
  if (questions.length === 0) return null

  if (part.state.status === 'running' || part.state.status === 'pending') {
    return (
      <div className="flex items-center gap-1.5 py-1 text-[12px] text-muted-foreground/70">
        <MessageCircleQuestion className="h-3.5 w-3.5" />
        {t('question.asking')}
      </div>
    )
  }

  const output = part.state.status === 'completed' ? toolOutputText(part.state.output) : ''
  const answers = parseAnswers(output, questions.length)

  return (
    <div className="min-w-0 max-w-full rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground/50">
        # {t('question.summaryHeading')}
      </div>
      <div className="flex flex-col gap-2.5">
        {questions.map((q, i) => {
          const a = answers?.[i]?.trim()
          return (
            <div key={i} className="flex flex-col gap-0.5">
              <span className="text-[12px] text-muted-foreground">{q.question}</span>
              <span className="text-[13px] text-foreground">
                {a || <em className="text-muted-foreground/70">{t('question.dismissed')}</em>}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function parseAnswers(output: string, count: number): string[] | null {
  if (!output) return null
  const lines = output.split('\n').filter((l) => l.trimStart().startsWith('- '))
  if (lines.length === 0) return null
  const ans = lines.map((l) => {
    const i = l.indexOf(' → ')
    const raw = i >= 0 ? l.slice(i + 3).trim() : ''
    return raw === '(sem resposta)' ? '' : raw
  })
  return Array.from({ length: count }, (_, i) => ans[i] ?? '')
}
