import type { TurnHooks } from '../providers/provider.js'
import { runtimeError } from '../turns/service.js'
export function proposeMemory(content: string, hooks: TurnHooks) {
  if (Buffer.byteLength(content) > 8192) throw runtimeError('LIMIT', 'Memory proposal exceeds 8 KiB')
  hooks.emit({ kind: 'memory.proposed', summary: 'Propondo uma memória', detail: { content } })
  return 'Proposta registrada; a pessoa decide se o bot deve lembrar'
}
