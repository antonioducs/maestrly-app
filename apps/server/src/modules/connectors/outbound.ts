/**
 * Outbound HTTP for connector callbacks.
 *
 * A URL supplied by a person is hostile until proven otherwise. The host is resolved before the request,
 * every resolved address is checked against the ranges that would reach this instance's own network, and the
 * request then connects to the address that was validated, so the name cannot resolve to something else in
 * between. Redirects are never followed: a 3xx is reported as a failure instead of being chased.
 */
import { lookup as resolveHost } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'

export class OutboundUrlError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'OutboundUrlError'
  }
}

/** Ranges that are never a legitimate external callback: loopback, link-local, private and reserved space. */
const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['64:ff9b::', 96],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6')

/** An address that cannot be parsed is treated as private: the request is refused rather than guessed. */
export function isPrivateAddress(address: string): boolean {
  const literal = address.replace(/^\[|\]$/g, '')
  const version = isIP(literal)
  if (version === 4) return blocked.check(literal, 'ipv4')
  if (version !== 6) return true
  // An IPv4-mapped address carries the real destination; it is judged by the IPv4 rules.
  const mapped = /^::ffff:(.+)$/i.exec(literal)
  if (mapped && isIP(mapped[1]!) === 4) return blocked.check(mapped[1]!, 'ipv4')
  return blocked.check(literal, 'ipv6')
}

export interface OutboundTarget {
  url: URL
  /** The validated address the request connects to. */
  address: string
  family: 4 | 6
}

export interface OutboundUrlOptions {
  /**
   * Allow a callback inside this network. Only for a self-hosted instance whose receiver is internal, and
   * for tests; it also permits plain HTTP, so it is never the default.
   */
  allowPrivateHosts: boolean
  /** Injected in tests. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
}

export async function resolveOutboundTarget(raw: string, options: OutboundUrlOptions): Promise<OutboundTarget> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OutboundUrlError('The callback URL is not a valid absolute URL.')
  }
  if (url.protocol !== 'https:' && !(options.allowPrivateHosts && url.protocol === 'http:'))
    throw new OutboundUrlError('A callback URL must use HTTPS.')
  if (url.username || url.password) throw new OutboundUrlError('A callback URL must not embed credentials.')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(hostname)
  const resolved = literal
    ? [{ address: hostname, family: literal }]
    : await (options.lookup ?? ((host: string) => resolveHost(host, { all: true, verbatim: true })))(hostname).catch(
        () => {
          throw new OutboundUrlError('The callback host could not be resolved.')
        }
      )
  if (!resolved.length) throw new OutboundUrlError('The callback host does not resolve to any address.')
  if (!options.allowPrivateHosts)
    for (const entry of resolved)
      if (isPrivateAddress(entry.address))
        throw new OutboundUrlError('The callback host resolves to an address inside this network.')
  const first = resolved[0]!
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 }
}

export interface OutboundResponse {
  status: number
  /** Bounded excerpt of the response, kept only to explain a failure. */
  detail: string
}

const MAX_RESPONSE_BYTES = 2_048

/** POST a body to a validated target. The response is bounded and the connection never follows a redirect. */
export function postOutboundJson(
  target: OutboundTarget,
  input: { body: Buffer; headers: Record<string, string>; timeoutMs: number }
): Promise<OutboundResponse> {
  const secure = target.url.protocol === 'https:'
  const agent = secure ? https : http
  return new Promise((resolve, reject) => {
    const request = agent.request(
      {
        protocol: target.url.protocol,
        host: target.url.hostname,
        port: target.url.port || (secure ? 443 : 80),
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        headers: { ...input.headers, 'content-length': String(input.body.byteLength) },
        servername: secure ? target.url.hostname : undefined,
        // Connect to the address that was validated: a second DNS answer cannot redirect this request.
        lookup: (_hostname, _options, callback) =>
          (callback as (error: null, address: string, family: number) => void)(null, target.address, target.family),
        timeout: input.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          if (size >= MAX_RESPONSE_BYTES) return
          size += chunk.byteLength
          chunks.push(chunk)
        })
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            detail: Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString('utf8').replace(/\s+/g, ' ').trim(),
          })
        )
        response.on('error', reject)
      }
    )
    request.on('timeout', () => request.destroy(new Error(`No response within ${input.timeoutMs} ms.`)))
    request.on('error', reject)
    request.end(input.body)
  })
}
