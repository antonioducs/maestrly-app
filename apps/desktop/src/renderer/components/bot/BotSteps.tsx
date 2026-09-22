import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Where the person is in the three moves that connect a bot: publish this computer, add the connector
 * inside the bot, approve the request that arrives here. Each step is derived from real state, never
 * from a wizard the screen remembers on its own.
 */
export interface BotStep {
  id: 'publish' | 'connect' | 'approve'
  title: string
  hint: string
  state: 'done' | 'current' | 'todo'
}

export function BotSteps({ steps }: { steps: BotStep[] }) {
  return (
    <ol data-testid="bot-steps" className="grid gap-2 sm:grid-cols-3">
      {steps.map((step, index) => (
        <li
          key={step.id}
          data-step={step.id}
          data-state={step.state}
          className={cn(
            'flex items-start gap-2.5 rounded-xl border p-3',
            step.state === 'done' && 'border-emerald-400/30',
            step.state === 'current' && 'border-sky-400/60 bg-sky-400/[0.05]',
            step.state === 'todo' && 'border-border'
          )}
        >
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
              step.state === 'done' && 'border-emerald-400 bg-emerald-400 text-black',
              step.state === 'current' && 'border-sky-400 bg-sky-400 text-black',
              step.state === 'todo' && 'border-border-strong text-muted-foreground'
            )}
          >
            {step.state === 'done' ? <Check className="size-3" /> : index + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-medium">{step.title}</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{step.hint}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
