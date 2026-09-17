/**
 * Projects a desktop tool part (AI SDK states, structured outputs, Maestro envelopes) onto the
 * view the shared card renders. The card knows nothing about providers; everything
 * desktop-specific is decided here.
 */
import type { ToolImageRef, ToolPartView, ToolViewState } from '@maestrly/chat-ui'
import { toolOutputImages, toolOutputText, type MessagePart, type ToolState } from '../../../shared/chat'
import { stripMaestroLiveEnvelope } from '../../../shared/maestro-live'
import { i18n } from '@/lib/i18n'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

export function toolViewState(state: ToolState): ToolViewState {
  return state.status === 'completed' ? 'done' : state.status
}

/** The reference the shared card hands back to `resolveImage`; only the desktop can decode it. */
export function toolImageRef(conversationId: string, messageId: string, toolPartId: string, imageId: string): string {
  return JSON.stringify({ conversationId, messageId, toolPartId, imageId })
}

export function toolPartView(part: ToolPart, conversationId: string, messageId: string): ToolPartView {
  const state = part.state
  const out =
    state.status === 'completed'
      ? state.output
      : state.status === 'running'
        ? (state.output ?? '')
        : state.status === 'error'
          ? state.error
          : state.status === 'denied'
            ? (state.reason ?? i18n.t('chat:tool.deniedByUser'))
            : ''
  const images = toolOutputImages(out)
  const output =
    typeof out === 'string'
      ? stripMaestroLiveEnvelope(out)
      : `${stripMaestroLiveEnvelope(toolOutputText(out))}${images.length ? `\n[${images.length} image output(s)]` : ''}`
  const refs: ToolImageRef[] = images.map((image) => ({
    id: image.id,
    name: image.name,
    ref: toolImageRef(conversationId, messageId, part.id, image.id),
  }))
  return {
    id: part.id,
    toolName: part.toolName,
    input: part.input,
    output,
    state: toolViewState(state),
    ...(refs.length ? { images: refs } : {}),
  }
}
