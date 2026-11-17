import type { ReactNode } from 'react'
import { useBotAvatarUrl } from '@/lib/fleet/bot-avatar'

/** What a bot's avatar needs: its picture when the owner gave it one, otherwise its initial on its color. */
export type BotAvatarBot = { id?: string; name: string; tint: string; avatar?: string | null }

/**
 * A bot's avatar. `className` sets its size, corners and initial's type; `children` (a status dot) sit over it.
 */
export function BotAvatar({
  bot,
  className,
  children,
  hidden = true,
}: {
  bot: BotAvatarBot
  className: string
  children?: ReactNode
  /** Most avatars sit beside the bot's name, which already says who it is. */
  hidden?: boolean
}) {
  const url = useBotAvatarUrl(bot.id, bot.avatar)
  return (
    <span
      aria-hidden={hidden || undefined}
      className={`relative flex shrink-0 items-center justify-center font-semibold text-white ${className}`}
      style={{ background: bot.tint }}
    >
      {url ? (
        <img src={url} alt="" draggable={false} className="size-full rounded-[inherit] object-cover" />
      ) : (
        bot.name.charAt(0).toUpperCase()
      )}
      {children}
    </span>
  )
}
