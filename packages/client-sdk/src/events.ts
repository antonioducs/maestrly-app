import { domainEventSchema, type DomainEvent } from '@maestrly/protocol'
import type { HttpTransport } from './transport.js'

export interface EventStreamOptions {
  organizationId: string
  projectId: string
  cursor?: number
  signal?: AbortSignal
}

function parseEventBlock(block: string): { id?: number; data?: string; event?:string } {
  let event: string | undefined
  let id: number | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event=line.slice(6).trim()
    if (line.startsWith('id:')) id = Number(line.slice(3).trim())
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  return { id, event, data: data.length > 0 ? data.join('\n') : undefined }
}

export async function* streamProjectEvents(
  transport: HttpTransport,
  options: EventStreamOptions,
): AsyncGenerator<DomainEvent> {
  let cursor = options.cursor ?? 0
  const decoder = new TextDecoder()
  let buffered = ''
  const path = `/api/v1/organizations/${encodeURIComponent(options.organizationId)}/projects/${encodeURIComponent(options.projectId)}/events?cursor=${cursor}`
  const response = await transport.fetch(path, {
    headers: { accept: 'text/event-stream', 'last-event-id': String(cursor) },
    signal: options.signal,
  })
  if (!response.ok || !response.body) throw new Error(`Event stream failed with status ${response.status}`)

  const reader = response.body.getReader()
  while (true) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    buffered += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    let boundary = buffered.indexOf('\n\n')
    while (boundary >= 0) {
      const block = parseEventBlock(buffered.slice(0, boundary))
      buffered = buffered.slice(boundary + 2)
      boundary = buffered.indexOf('\n\n')
      if(block.event==='access_revoked')throw new Error('Project access was revoked.')
      if (!block.data) continue
      const event = domainEventSchema.parse(JSON.parse(block.data))
      if (event.sequence <= cursor) continue
      cursor = block.id ?? event.sequence
      yield event
    }
  }
}
