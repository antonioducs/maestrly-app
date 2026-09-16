import type { ChatMessage, MessagePart } from '../../shared/chat'
import { droppedImageText, nativeSeedContextText, renderNativeSeedTranscript } from './message'

/** Codex rejects an oversized text input independently of the model's token window. */
export const CODEX_TRANSFER_MAX_CHARACTERS = 1_048_576

/** Include the import wrapper and pending text; image descriptions are a conservative allowance. */
export function codexTransferCharacters(history: readonly ChatMessage[], pending: readonly MessagePart[]): number {
  const text: string[] = []
  const seed = renderNativeSeedTranscript(history)
  if (seed) text.push(nativeSeedContextText(seed))
  for (const part of pending) {
    if (part.type === 'text' && part.text) text.push(part.text)
    else if (part.type === 'skill-invocation' && part.body) text.push(part.body)
    else if (part.type === 'file') {
      if (part.kind === 'image') text.push(droppedImageText(part))
      else text.push(`${part.hidden ? 'Content referenced by' : 'Attached file'} ${part.name}:\n\n${part.data}`)
    }
  }
  return text.join('\n\n').length
}
