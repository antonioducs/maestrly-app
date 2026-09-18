import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@maestrly/ui'

/** The common conversation canvas used by the Maestrly App and Maestrly Bot. */
export const ChatSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('relative flex h-full w-full min-h-0 min-w-0 flex-col bg-[#0d0d10]', className)}
      {...props}
    />
  )
)
ChatSurface.displayName = 'ChatSurface'

/** The compact native-window toolbar that sits above a conversation. */
export function ChatTopBar({
  leading,
  trailing,
  className,
}: {
  leading: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'chat-topbar flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3',
        className
      )}
    >
      <div className="min-w-0 flex-1 overflow-hidden">{leading}</div>
      {trailing && <div className="flex min-w-0 shrink-0 items-center gap-2">{trailing}</div>}
    </header>
  )
}

/** The scrolling region. Content and composer remain independently sized around it. */
export const ChatMessageViewport = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden', className)} {...props} />
  )
)
ChatMessageViewport.displayName = 'ChatMessageViewport'

/** The exact readable measure and rhythm of the Maestrly App transcript. */
export const ChatMessageContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('chat-msgs mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 px-3 py-5', className)}
      {...props}
    />
  )
)
ChatMessageContent.displayName = 'ChatMessageContent'

/** The composer gutter used at the bottom of both conversation views. */
export function ChatComposerDock({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-3 pb-3 pt-1', className)} {...props} />
}

/** The content measure used by the Usage section in Maestrly App settings. */
export function SettingsContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mx-auto flex w-full max-w-2xl flex-col gap-7 px-6 py-6', className)} {...props} />
}
