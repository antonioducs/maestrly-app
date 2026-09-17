import {
  hostSchema,
  vmSchema,
  operationSchema,
  verifyResultSchema,
  botResultSchemas,
  teamResultSchemas,
  routineResultSchemas,
  voiceResultSchemas,
  promptResultSchemas,
  type PromptMethod,
  extensionResultSchemas,
  type ExtensionMethod,
  usageResultSchemas,
  type UsageMethod,
  type BotMethod,
  type TeamMethod,
  type RoutineMethod,
  type VoiceMethod,
  type Host,
  type Vm,
  type Operation,
} from '@maestrly/host-protocol'
export type { Host, Vm, Operation }
export type HostEvent = { seq: number; kind: string; createdAt: string; value: unknown }
export type HostImage = { id: string; name: string; available: boolean; reason?: string }
// Diagnostics remain text, never renderer capabilities or local endpoint paths.
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[bounded]'
  if (typeof value === 'string')
    return value
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/(?:\/[\w.@~-]+){2,}/g, '[host path]')
      .slice(0, 2048)
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitize(v, depth + 1))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !/path|socket|token|secret|password|privatekey/i.test(k))
        .slice(0, 40)
        .map(([k, v]) => [k, sanitize(v, depth + 1)])
    )
  return value
}
export function validateResult(method: string, value: unknown): unknown {
  // Bot results are typed projections: chat content, code and guest paths pass through intact.
  if (method.startsWith('bot.') || method.startsWith('account.') || method.startsWith('environment.')) {
    const schema = botResultSchemas[method as BotMethod]
    if (!schema) throw new Error('Unsupported bot result')
    return schema.parse(value)
  }
  // Team results are typed projections too: their text must not pass through the
  // diagnostic sanitizer, which would strip exactly the content the person asked for.
  // Routine and voice results are typed projections as well. A routine's request and a voice
  // transcript are the person's own words: running them through the diagnostic sanitizer would
  // strip paths out of the very text they dictated.
  if (method.startsWith('routine.')) {
    const schema = routineResultSchemas[method as RoutineMethod]
    if (!schema) throw new Error('Unsupported routine result')
    return schema.parse(value)
  }
  if (method.startsWith('prompt.')) {
    const schema = promptResultSchemas[method as PromptMethod]
    if (!schema) throw new Error('Unsupported prompt result')
    return schema.parse(value)
  }
  // Extension states are typed too, and the schema itself has no place for a secret value.
  if (method.startsWith('extension.')) {
    const schema = extensionResultSchemas[method as ExtensionMethod]
    if (!schema) throw new Error('Unsupported extension result')
    return schema.parse(value)
  }
  if (method.startsWith('usage.')) {
    const schema = usageResultSchemas[method as UsageMethod]
    if (!schema) throw new Error('Unsupported usage result')
    return schema.parse(value)
  }
  if (method.startsWith('voice.')) {
    const schema = voiceResultSchemas[method as VoiceMethod]
    if (!schema) throw new Error('Unsupported voice result')
    return schema.parse(value)
  }
  if (method.startsWith('team.')) {
    const schema = teamResultSchemas[method as TeamMethod]
    if (!schema) throw new Error('Unsupported team result')
    return schema.parse(value)
  }
  if (method === 'host.inspect') {
    const host = hostSchema.parse(value)
    return {
      ...host,
      runtimes: host.runtimes.map((runtime) => ({
        ...runtime,
        ...(runtime.reason ? { reason: String(sanitize(runtime.reason)) } : {}),
      })),
    }
  }
  if (method === 'operation.lookup' && value === null) return null
  if (method === 'vm.logs') {
    if (
      !Array.isArray(value) ||
      value.length > 200 ||
      value.some((line) => typeof line !== 'string' || line.length > 2048)
    )
      throw new Error('Invalid guest console')
    return value.map((line) => String(sanitize(line)))
  }
  if (method === 'vm.verify') return verifyResultSchema.parse(value)
  if (method === 'vm.list') {
    if (!Array.isArray(value)) throw new Error('Invalid VM list')
    return value.map((v) => vmSchema.parse(v))
  }
  if (method === 'vm.inspect') return vmSchema.parse(value)
  if (method.startsWith('operation.') || method.startsWith('vm.')) {
    const operation = operationSchema.parse(value)
    return {
      ...operation,
      ...(operation.error ? { error: { ...operation.error, message: String(sanitize(operation.error.message)) } } : {}),
    }
  }
  if (!Array.isArray(value)) throw new Error('Invalid host list')
  if (method === 'image.list')
    return value.map((v) => {
      if (!v || typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.available !== 'boolean')
        throw new Error('Invalid image')
      return {
        id: v.id,
        name: v.name,
        available: v.available,
        ...(typeof v.reason === 'string' ? { reason: sanitize(v.reason) } : {}),
      }
    })
  if (method === 'events.list')
    return value.map((v) => {
      if (
        !v ||
        !Number.isSafeInteger(v.seq) ||
        v.seq < 1 ||
        typeof v.kind !== 'string' ||
        typeof v.createdAt !== 'string' ||
        !Object.hasOwn(v, 'value')
      )
        throw new Error('Invalid event')
      return { seq: v.seq, kind: sanitize(v.kind), createdAt: v.createdAt, value: sanitize(v.value) }
    })
  throw new Error('Unsupported host result')
}

export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}
