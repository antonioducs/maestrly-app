import { Markdown } from '@maestrly/chat-ui'
import { safeHttpsUrl } from './markdown'

/**
 * The Bot's link policy on top of the shared renderer: only clean https links become links,
 * and no image is ever fetched. Anything else renders as inert text — the same guarantee the
 * previous hand-written renderer gave.
 */
export function botUrlTransform(value: string, key: string): string {
  if (key !== 'href') return ''
  return safeHttpsUrl(value) ?? ''
}

export function BotMarkdown({ text }: { text: string }) {
  return <Markdown text={text} urlTransform={botUrlTransform} allowImages={false} />
}
