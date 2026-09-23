import { useTranslation } from 'react-i18next'
import { Circle, CircleDot, CheckCircle2, ListChecks } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatTodo, MessagePart } from '../../../shared/chat'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

export function TodoCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation('chat')
  // Streamed and failed tool calls can contain input that never passed tool validation.
  const inputTodos = (part.input as { todos?: unknown } | null)?.todos
  const todos = (Array.isArray(inputTodos) ? inputTodos : []).filter(
    (x: unknown): x is ChatTodo =>
      typeof x === 'object' &&
      x !== null &&
      'content' in x &&
      typeof x.content === 'string' &&
      'status' in x &&
      (x.status === 'pending' || x.status === 'in_progress' || x.status === 'completed')
  )
  if (todos.length === 0) return null
  const done = todos.filter((x) => x.status === 'completed').length

  return (
    <div className="min-w-0 max-w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <ListChecks className="h-3.5 w-3.5" />
        {t('todo.heading')}
        <span className="ml-auto tabular-nums text-muted-foreground/60">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            {todo.status === 'completed' ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            ) : todo.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse text-amber-400" />
            ) : (
              <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                'min-w-0 break-words',
                todo.status === 'completed'
                  ? 'text-muted-foreground line-through'
                  : todo.status === 'in_progress'
                    ? 'text-foreground'
                    : 'text-muted-foreground'
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
