import { Circle, CircleDot, HelpCircle, Loader2 } from 'lucide-react'

export type AgentStatus = 'idle' | 'working' | 'ready' | 'waiting' | 'asking' | 'error'

export function StatusIcon({ status }: { status: AgentStatus }) {
  switch (status) {
    case 'working':
      return (
        <span className="animate-breathe inline-flex shrink-0 text-status-working">
          <Loader2 className="size-3.5 animate-spin" />
        </span>
      )
    case 'ready':
      return <CircleDot className="size-3.5 shrink-0 text-status-ready" />
    case 'waiting':
      return <CircleDot className="size-3.5 shrink-0 text-status-waiting" />
    case 'asking':
      return <HelpCircle className="size-3.5 shrink-0 text-status-waiting" />
    case 'error':
      return <CircleDot className="size-3.5 shrink-0 text-status-error" />
    default:
      return <Circle className="size-3.5 shrink-0 text-muted-foreground" />
  }
}
