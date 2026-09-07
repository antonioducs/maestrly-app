/**
 * `webfetch` tool — ported from opencode tool/webfetch.ts (without Effect). Gated network egress.
 * HTML is parsed into inert text; non-HTML content and explicitly requested HTML remain raw.
 */
import { net } from 'electron'
import { z } from 'zod'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { defineTool, type ToolContext } from './util'

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const params = z.object({
  url: z.string().describe('HTTP/HTTPS URL to fetch.'),
  format: z.enum(['text', 'markdown', 'html']).default('markdown').describe('Desired output format.'),
  timeout: z
    .number()
    .gt(0)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(`Timeout in seconds (max ${MAX_TIMEOUT_SECONDS}).`),
})

interface WebfetchResult {
  url: string
  contentType: string
  output: string
}

function isTextualMime(mime: string): boolean {
  return (
    mime === '' ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml') ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript'
  )
}

const OMITTED_HTML_ELEMENTS = new Set(['script', 'style', 'noscript', 'template'])
const LINE_BREAK_ELEMENTS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'br'])

/** Extract text, not sanitized HTML. The parser decodes entities exactly once and never executes scripts. */
function htmlToText(html: string): string {
  const chunks: string[] = []
  // Iterative traversal also handles deeply nested untrusted documents without recursive stack growth.
  const pending: Array<DefaultTreeAdapterMap['node'] | '\n'> = [parseFragment(html)]
  while (pending.length) {
    const node = pending.pop()!
    if (node === '\n') {
      chunks.push(node)
    } else if ('value' in node) {
      chunks.push(node.value)
    } else if ('childNodes' in node) {
      if ('tagName' in node) {
        if (OMITTED_HTML_ELEMENTS.has(node.tagName)) continue
        if (LINE_BREAK_ELEMENTS.has(node.tagName)) pending.push('\n')
      }
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index])
    }
  }
  return chunks
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => {})
        throw new Error('Response too large (5MB limit).')
      }
      chunks.push(Buffer.from(value))
    }
  }
  return Buffer.concat(chunks)
}

export function webfetchPermissionResource(u: URL): string {
  return `${u.protocol}//${u.host}`
}

export function webfetchPermissionSavePattern(u: URL): string {
  return `${webfetchPermissionResource(u)}/*`
}

async function run(args: z.infer<typeof params>, ctx: ToolContext): Promise<WebfetchResult> {
  let u: URL
  try {
    u = new URL(args.url)
  } catch {
    throw new Error('Invalid URL.')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The URL must use http:// or https://')
  const permissionResource = `${webfetchPermissionResource(u)}${u.pathname || '/'}${u.search}`
  await ctx.ask('webfetch', [permissionResource], [webfetchPermissionSavePattern(u)])

  const ac = AbortSignal.any([ctx.signal, AbortSignal.timeout((args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000)])
  const headers = { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' }
  const fetchImpl = net.fetch as unknown as typeof globalThis.fetch
  let res = await fetchImpl(args.url, { headers, signal: ac, redirect: 'follow' })
  if (res.status === 403 && res.headers.get('cf-mitigated') === 'challenge') {
    res = await fetchImpl(args.url, {
      headers: { ...headers, 'User-Agent': 'maestrly' },
      signal: ac,
      redirect: 'follow',
    })
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

  const ct = res.headers.get('content-type') ?? ''
  const mime = ct.split(';')[0].trim().toLowerCase()
  if (mime.startsWith('image/')) throw new Error(`Unsupported image content type: ${mime}`)
  if (!isTextualMime(mime)) throw new Error(`Unsupported content type: ${mime}`)
  const len = res.headers.get('content-length')
  if (len && Number(len) > MAX_RESPONSE_BYTES) throw new Error('Response too large (5MB limit).')
  if (!res.body) throw new Error('Response has no body.')

  const buf = await readCapped(res.body, MAX_RESPONSE_BYTES)
  const raw = new TextDecoder().decode(buf)
  const output = mime === 'text/html' && args.format !== 'html' ? htmlToText(raw) : raw
  return { url: args.url, contentType: ct, output }
}

export const webfetchTool = defineTool({
  name: 'webfetch',
  description:
    'Fetches the contents of an http/https URL (HTML converted to text). Asks for permission (network egress).',
  parameters: params,
  execute: run,
  toModelText: (_args, r) => r.output,
})
