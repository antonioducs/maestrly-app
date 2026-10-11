import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import type { FleetGatewayEvent, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { EventHub } from '../src/events.js'

/** A subscriber connection that keeps what it was sent. */
function subscriber() {
  const frames: string[] = []
  const response = {
    destroyed: false,
    writableLength: 0,
    writeHead: () => response,
    write: (chunk: string) => {
      frames.push(chunk)
      return true
    },
    on: () => response,
    destroy: () => {},
    end: () => {},
  }
  const sent = () =>
    frames
      .filter((frame) => frame.startsWith('event: fleet'))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as FleetGatewayEvent)
  return { response: response as unknown as ServerResponse, sent }
}

describe('event hub', () => {
  it('sends reasoning items only to devices that asked for them, and every other event to all', () => {
    const hub = new EventHub(async () => {})
    const older = subscriber()
    const reader = subscriber()
    hub.add(older.response, 0, 'mac-old')
    hub.add(reader.response, 0, 'mac-new', { reasoning: true })
    const at = '2026-09-29T10:00:00.000Z'
    const upsert = (item: FleetTranscriptItem): FleetGatewayEvent => ({
      type: 'transcript.upsert',
      at,
      botId: 'alpha',
      item,
    })
    hub.emit(upsert({ kind: 'reasoning', id: 'm:0', at, text: 'Thinking', truncated: false, streaming: true }))
    hub.emit(upsert({ kind: 'assistant', id: 'm:1', at, text: 'Answer', streaming: false }))
    hub.emit({ type: 'transcript.reset', at, botId: 'alpha' })
    const shape = (events: FleetGatewayEvent[]) =>
      events.map((event) => (event.type === 'transcript.upsert' ? event.item.kind : event.type))
    expect(shape(older.sent())).toEqual(['hello', 'assistant', 'transcript.reset'])
    expect(shape(reader.sent())).toEqual(['hello', 'reasoning', 'assistant', 'transcript.reset'])
    hub.close()
  })
})
