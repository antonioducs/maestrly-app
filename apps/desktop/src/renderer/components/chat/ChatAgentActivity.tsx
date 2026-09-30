import type { OpenFileReference } from '@/components/MarkdownViewer'
import { baseToolName, type ActivityStep, type ActivityToolStep } from '@/lib/agent-activity'
import { toolOutputImages, type ChatMessage, type MessagePart } from '../../../shared/chat'
import { AgentActivity } from './AgentActivity'
import { SubagentCard } from './SubagentCard'
import { ToolCallDetails, ToolImagePreview } from './ToolCallCard'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

/** Tool screenshots and images stay in view under the activity line: the newest few. */
const THUMBNAILS_MAX = 6

/** The activity of a chat message: its steps' details are the tool cards' own. */
export function ChatAgentActivity({
  message,
  steps,
  live,
  writing,
  waitingAnswer,
  onOpenImage,
  onOpenMention,
  searchQuery,
  currentSearchMatch,
}: {
  message: ChatMessage
  steps: ActivityStep<MessagePart>[]
  live: boolean
  writing: boolean
  waitingAnswer: boolean
  onOpenImage?: (src: string, name: string) => void
  onOpenMention?: OpenFileReference
  searchQuery?: string
  currentSearchMatch?: boolean
}) {
  const conversationId = message.conversationId
  const images = steps
    .flatMap((step) =>
      step.kind === 'tool' && step.source.type === 'tool' && step.source.state.status === 'completed'
        ? toolOutputImages(step.source.state.output).map((image) => ({ image, part: step.source as ToolPart }))
        : []
    )
    .slice(-THUMBNAILS_MAX)
  const renderToolDetail = (step: ActivityToolStep<MessagePart>) => {
    const part = step.source as ToolPart
    if (baseToolName(part.toolName) === 'task')
      return (
        <SubagentCard
          part={part}
          conversationId={conversationId}
          messageId={message.id}
          onOpenMention={onOpenMention}
        />
      )
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
      durationMs={live ? null : (message.responseDurationMs ?? null)}
      thumbnails={
        images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-1 pt-1">
            {images.map(({ image, part }) => (
              <ToolImagePreview
                key={`${part.id}:${image.id}`}
                variant="thumb"
                image={image}
                conversationId={conversationId}
                messageId={message.id}
                toolPartId={part.id}
                onOpenImage={onOpenImage}
              />
            ))}
          </div>
        )
      }
      renderToolDetail={renderToolDetail}
      onOpenMention={onOpenMention}
      searchQuery={searchQuery}
      currentSearchMatch={currentSearchMatch}
    />
  )
}
