import { GENUI_WIDGET_FENCE } from '../../shared/genui-widget'

// Fences of a message that render as interfaces: ```inline-html, shown in an isolated frame.

const fenceLanguage = (className: string): string | undefined => /\blanguage-([\w-]+)/.exec(className)?.[1]

export const isWidgetFence = (className: string): boolean => fenceLanguage(className) === GENUI_WIDGET_FENCE

/**
 * A fence that may still turn into an interface: its language is being streamed (`inl` of `inline-html`) or it has
 * no content yet. Showing it as code would flash a code block for a moment.
 */
export function isPendingFence(className: string, code: string): boolean {
  const language = fenceLanguage(className)
  return code === '' || (!!language && language !== GENUI_WIDGET_FENCE && GENUI_WIDGET_FENCE.startsWith(language))
}

/**
 * Whether the source of a fenced block already holds its closing fence: then it is complete even while the message
 * goes on streaming. An unclosed fence runs to the end of the message.
 */
export function isFenceClosed(source: string): boolean {
  const lines = source.replace(/\r\n?/g, '\n').trimEnd().split('\n')
  if (lines.length < 2) return false
  const open = /^\s*(`{3,}|~{3,})/.exec(lines[0])
  const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1])
  return !!open && !!close && close[1][0] === open[1][0] && close[1].length >= open[1].length
}
