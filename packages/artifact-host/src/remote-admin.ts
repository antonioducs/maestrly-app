import type { ArtifactAdmin } from './admin.js'
import { ArtifactHostError, type SerializedArtifactError } from './errors.js'
import { ADMIN_METHODS, type AdminMethod, serializeAdminError } from './rpc.js'

export type AdminResult = { ok: true; value: unknown } | { ok: false; error: SerializedArtifactError }
export const UPLOAD_METHODS = ['create', 'update', 'setThumbnail'] as const satisfies readonly AdminMethod[]

const MAX_DEPTH = 16
const invalid = (message: string) => new ArtifactHostError('invalid_input', message)

function codec(value: unknown, decode: boolean, depth: number): unknown {
  if (depth > MAX_DEPTH) throw invalid('Admin values exceed the nesting limit')
  if (!decode && value === undefined) return { $undefined: true }
  if (!decode && value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item) => codec(item, decode, depth + 1))
  if (typeof value !== 'object' || value === null) throw invalid('Unsupported admin value')
  const entries = Object.entries(value)
  if (decode && entries.length === 1) {
    const [key, data] = entries[0]!
    if (key === '$undefined' && data === true) return undefined
    if (key === '$bytes') {
      if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
        throw invalid('Invalid base64 admin bytes')
      const bytes = Buffer.from(data, 'base64')
      if (bytes.toString('base64') !== data) throw invalid('Invalid base64 admin bytes')
      return new Uint8Array(bytes)
    }
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, codec(item, decode, depth + 1)]))
}

/** Encode JSON data, reserving exact {$bytes: string} and {$undefined: true} objects as wire tags. */
export function toWire(value: unknown): unknown {
  return codec(value, false, 0)
}

/** Decode canonical base64 bytes and undefined tags, with at most sixteen levels of nesting. */
export function fromWire(value: unknown): unknown {
  return codec(value, true, 0)
}

/** Dispatch an explicitly allowed call through the admin's existing input validation. */
export async function callAdmin(
  admin: ArtifactAdmin,
  method: string,
  wireArgs: unknown,
  options: {
    allowed: readonly AdminMethod[]
    guard?: (method: AdminMethod, args: unknown[]) => unknown[] | Promise<unknown[]>
  }
): Promise<AdminResult> {
  try {
    if (
      !(ADMIN_METHODS as readonly string[]).includes(method) ||
      !(options.allowed as readonly string[]).includes(method)
    )
      throw invalid('Unknown or denied admin call')
    if (!Array.isArray(wireArgs) || wireArgs.length > 3) throw invalid('Invalid admin arguments')
    const name = method as AdminMethod
    let args = fromWire(wireArgs) as unknown[]
    if (options.guard) args = await options.guard(name, args)
    if (!Array.isArray(args) || args.length > 3) throw invalid('Invalid admin arguments')
    const fn = admin[name] as (...args: unknown[]) => Promise<unknown>
    return { ok: true, value: toWire(await fn.apply(admin, args)) }
  } catch (error) {
    return { ok: false, error: serializeAdminError(error) }
  }
}

/** An admin client for a JSON transport supplied by the caller. */
export function createRemoteAdmin(
  send: (method: AdminMethod, wireArgs: unknown[]) => Promise<AdminResult>
): ArtifactAdmin {
  return Object.fromEntries(
    ADMIN_METHODS.map((method) => [
      method,
      async (...args: unknown[]) => {
        while (args.length && args.at(-1) === undefined) args.pop()
        const result = await send(method, toWire(args) as unknown[])
        if (!result.ok) throw ArtifactHostError.from(result.error)
        return fromWire(result.value)
      },
    ])
  ) as unknown as ArtifactAdmin
}
