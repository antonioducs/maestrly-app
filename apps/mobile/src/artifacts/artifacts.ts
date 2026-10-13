import {
  FLEET_ARTIFACTS_FEATURE,
  FLEET_ARTIFACTS_GATEWAY_VIEWER_FEATURE,
  type MobileChatItem,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError, type GatewayClient } from '../gateway/client'

/** A page an agent published, as the card in the conversation shows it. */
export type ArtifactPublication = { id: string; title: string; version: number }
export type ArtifactOpenIssue = 'unsupported' | 'off' | 'noAddress' | 'gone' | 'offline' | 'demo'

export class ArtifactOpenError extends Error {
  constructor(readonly issue: ArtifactOpenIssue) {
    super(issue)
    this.name = 'ArtifactOpenError'
  }
}

const PUBLISHERS = new Set(['artifact_create', 'artifact_update'])
const ID = /^[A-Za-z0-9_-]{22}$/
const TITLE_MAX = 200
/**
 * The start of a publication's result, `{"ok":true,"artifact":{"id","title","version"}, …}`. Transcripts keep only the
 * first characters of a tool's output, so the rest may be cut off.
 */
const RESULT_HEAD = /^\{"ok":true,"artifact":\{"id":"([A-Za-z0-9_-]{22})","title":("(?:[^"\\]|\\.)*"),"version":(\d+)\}/

/** Tool names carry their server's prefix on some runtimes, such as `mcp__maestrly__artifact_create`. */
const baseToolName = (name: string) => name.split(/__|\./).at(-1) ?? name

/** The page a finished `artifact_create` or `artifact_update` published, or null for any other item. */
export function artifactPublication(item: MobileChatItem): ArtifactPublication | null {
  if (item.kind !== 'tool' || item.state !== 'done' || !item.output || !PUBLISHERS.has(baseToolName(item.name)))
    return null
  const head = RESULT_HEAD.exec(item.output.trim())
  if (!head) return null
  let title: unknown
  try {
    title = JSON.parse(head[2] as string)
  } catch {
    return null
  }
  const version = Number(head[3])
  if (typeof title !== 'string' || !ID.test(head[1] as string) || !Number.isSafeInteger(version) || version < 1)
    return null
  return { id: head[1] as string, title: title.slice(0, TITLE_MAX), version }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const isLoopback = (url: URL) => url.protocol === 'http:' && LOOPBACK.has(url.hostname)

/**
 * Where the phone opens the server's artifact viewer. The viewer answers only at the server's public address (and on
 * loopback), so a phone needs that address; it must be HTTPS, because the link carries a ticket. A development build
 * on the same computer also reaches a gateway that serves the viewer on loopback.
 */
export function artifactViewerBase(options: {
  origin: string
  features: readonly string[]
  publicAddress: string
  allowLoopback: boolean
}): string | null {
  const parse = (value: string) => {
    try {
      return new URL(value)
    } catch {
      return null
    }
  }
  const address = options.publicAddress ? parse(options.publicAddress) : null
  if (address && (address.protocol === 'https:' || (options.allowLoopback && isLoopback(address))))
    return address.origin
  const origin = parse(options.origin)
  if (
    options.allowLoopback &&
    origin &&
    isLoopback(origin) &&
    options.features.includes(FLEET_ARTIFACTS_GATEWAY_VIEWER_FEATURE)
  )
    return origin.origin
  return null
}

/**
 * The link that opens one version of an artifact as its owner. The ticket is single-use and expires within a minute;
 * it travels in the fragment, which the viewer removes from the address bar at once.
 */
export async function artifactLink(
  client: GatewayClient,
  server: { origin: string; features: readonly string[] },
  artifact: { id: string; version: number },
  allowLoopback: boolean
): Promise<string> {
  if (!server.features.includes(FLEET_ARTIFACTS_FEATURE)) throw new ArtifactOpenError('unsupported')
  try {
    const host = await client.call('artifactHost')
    if (!host.settings.enabled || host.status.state !== 'running') throw new ArtifactOpenError('off')
    const base = artifactViewerBase({
      origin: server.origin,
      features: server.features,
      publicAddress: host.settings.publicAddress,
      allowLoopback,
    })
    if (!base) throw new ArtifactOpenError('noAddress')
    const result = await client.call('artifactAdmin', { body: { method: 'mintOwnerTicket', args: [artifact.id] } })
    if (!result.ok) throw new ArtifactOpenError(result.error.code === 'host_unavailable' ? 'off' : 'gone')
    const ticket = (result.value as { ticket?: unknown } | null)?.ticket
    if (typeof ticket !== 'string' || !ticket) throw new ArtifactOpenError('gone')
    return `${base}/a/${encodeURIComponent(artifact.id)}#o=${encodeURIComponent(ticket)}&v=${artifact.version}`
  } catch (error) {
    if (error instanceof ArtifactOpenError) throw error
    if (error instanceof GatewayError && error.code === 'NOT_FOUND') throw new ArtifactOpenError('unsupported')
    throw new ArtifactOpenError('offline')
  }
}
