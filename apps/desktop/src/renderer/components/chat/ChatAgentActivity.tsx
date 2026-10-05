import type { OpenFileReference } from '@/components/MarkdownViewer'
import type { ActivityStep, ActivityToolStep } from '@/lib/agent-activity'
import type { ChatMessage, MessagePart } from '../../../shared/chat'
import { AgentActivity } from './AgentActivity'
import { ToolCallDetails } from './ToolCallCard'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

/**
 * The activity of a chat message: its steps' details are the tool cards' own, including the screenshots the agent
 * took for itself. The ones it shared with the person show outside the activity.
 */
export function ChatAgentActivity({
  message,
  steps,
  live,
  writing,
  waitingAnswer,
  subagents,
  onOpenMention,
  searchQuery,
  currentSearchMatch,
}: {
  message: ChatMessage
  steps: ActivityStep<MessagePart>[]
  live: boolean
  writing: boolean
  waitingAnswer: boolean
  subagents: { total: number; running: number }
  onOpenMention?: OpenFileReference
  searchQuery?: string
  currentSearchMatch?: boolean
}) {
  const conversationId = message.conversationId
  const renderToolDetail = (step: ActivityToolStep<MessagePart>) => {
    const part = step.source as ToolPart
    return (
      <div className="min-w-0 max-w-full rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-[13px]">
        <ToolCallDetails part={part} conversationId={conversationId} messageId={message.id} />
      </div>
    )
  }
  return (
    <AgentActivity
      steps={steps}
      live={live}
      writing={writing}
      waitingAnswer={waitingAnswer}
      runningSubagents={subagents.running}
      worked={subagents.total > 0}
      durationMs={live ? null : (message.responseDurationMs ?? null)}
      renderToolDetail={renderToolDetail}
      onOpenMention={onOpenMention}
      searchQuery={searchQuery}
      currentSearchMatch={currentSearchMatch}
    />
  )
}
