import { useState, type ReactNode } from 'react'
import { ChevronRight, BrainCircuit } from 'lucide-react'
import type { Options } from 'react-markdown'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { Markdown } from '../markdown/Markdown'
import { ToolCallCard } from './ToolCallCard'
import { CopyButton } from './CopyButton'
import { ResponseDuration } from './ResponseDuration'
import type { ToolPartView } from './types'

/** The transcript shape both applications render; the Bot's wire type satisfies it structurally. */
export interface TranscriptPartLike {
  type: 'text' | 'reasoning' | 'tool' | 'file'
  id: string
  text?: string
  callId?: string
  toolName?: string
  summary?: string
  input?: unknown
  output?: string
  exitCode?: number
  changes?: { path: string; kind: string }[]
  state?: 'running' | 'done' | 'error'
  path?: string
  name?: string
  size?: number
}
export interface TranscriptMessageLike {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: string
  parts: TranscriptPartLike[]
  streaming: boolean
  responseStartedAt?: string
  responseDurationMs?: number
  error?: { code: string; message: string }
}

export interface TranscriptSlots<M extends TranscriptMessageLike> {
  /** Rendered instead of the text for a system message (a continuation notice, for instance). */
  system?: (message: M) => ReactNode
  /** Rendered after the parts: attachments, audio bubbles, anything the application owns. */
  after?: (message: M) => ReactNode
  /** Rendered for a `file` part; undefined shows the file name. */
  file?: (part: TranscriptPartLike, message: M) => ReactNode
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1 text-[12px] text-muted-foreground" data-reasoning>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded px-1 hover:bg-white/[0.06]"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        <BrainCircuit className="h-3 w-3" />
        <span className="truncate">{text.slice(0, 80)}</span>
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap rounded bg-black/20 p-2 font-mono text-[11px]">{text}</pre>}
    </div>
  )
}

export function toolPartView(part: TranscriptPartLike): ToolPartView {
  return {
    id: part.id,
    toolName: part.toolName ?? 'tool',
    summary: part.summary,
    input: part.input,
    output: part.output,
    exitCode: part.exitCode,
    changes: part.changes,
    state: part.state ?? 'running',
  }
}

const plainText = (message: TranscriptMessageLike) =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')

/**
 * The list of messages as a person reads it: markdown for what the bot wrote, a card per tool
 * call that updates while it runs, reasoning folded away, the time of each message and how
 * long an answer took. Everything that depends on an application (files, audio, notices)
 * comes through slots.
 */
export function TranscriptList<M extends TranscriptMessageLike>({
  messages,
  slots = {},
  urlTransform,
  allowImages = true,
}: {
  messages: M[]
  slots?: TranscriptSlots<M>
  urlTransform?: Options['urlTransform']
  allowImages?: boolean
}) {
  const { locale } = useChatUi()
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
  return (
    <>
      {messages.map((message) => {
        const text = plainText(message)
        const startedAt = message.responseStartedAt ? Date.parse(message.responseStartedAt) : undefined
        return (
          <article
            className={cn('message group', message.role, 'flex w-full min-w-0 max-w-full flex-col gap-1')}
            key={message.id}
            data-message-id={message.id}
            data-streaming={message.streaming || undefined}
          >
            {message.role === 'system' && slots.system ? (
              slots.system(message)
            ) : message.role === 'user' ? (
              <p className="whitespace-pre-wrap break-words rounded-xl border border-white/[0.06] bg-white/[0.05] px-3.5 py-2.5 text-[15px] leading-relaxed text-foreground">
                {text}
              </p>
            ) : (
              message.parts.map((part) =>
                part.type === 'text' ? (
                  <Markdown
                    key={part.id}
                    text={part.text ?? ''}
                    urlTransform={urlTransform}
                    allowImages={allowImages}
                  />
                ) : part.type === 'reasoning' ? (
                  <Reasoning key={part.id} text={part.text ?? ''} />
                ) : part.type === 'tool' ? (
                  <div key={part.id} className="my-2">
                    <ToolCallCard part={toolPartView(part)} />
                  </div>
                ) : (
                  <div key={part.id}>{slots.file ? slots.file(part, message) : <span>{part.name}</span>}</div>
                )
              )
            )}
            {slots.after?.(message)}
            <footer className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <time dateTime={message.createdAt} className="tabular-nums">
                {time.format(new Date(message.createdAt))}
              </time>
              {message.role === 'assistant' &&
                (message.responseDurationMs != null || (message.streaming && startedAt != null)) && (
                  <ResponseDuration
                    startedAt={message.streaming ? startedAt : undefined}
                    durationMs={message.responseDurationMs}
                  />
                )}
              {text.trim() && (
                <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <CopyButton text={text} />
                </span>
              )}
            </footer>
          </article>
        )
      })}
    </>
  )
}
