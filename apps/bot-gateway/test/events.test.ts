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

  it('sends threads between bots only to devices that asked for them', () => {
    const hub = new EventHub(async () => {})
    const older = subscriber()
    const threads = subscriber()
    hub.add(older.response, 0, 'mac-old', { routineRuns: true })
    hub.add(threads.response, 0, 'mac-threads', { peerThreads: true })
    const at = '2026-10-18T10:00:00.000Z'
    hub.emit({
      type: 'peer_thread.transcript.upsert',
      at,
      botId: 'alpha',
      threadId: 'thread-1',
      item: { kind: 'reasoning', id: 'm:0', at, text: 'Thinking', truncated: false, streaming: true },
    })
    hub.emit({
      type: 'peer_thread.transcript.upsert',
      at,
      botId: 'alpha',
      threadId: 'thread-1',
      item: { kind: 'assistant', id: 'm:1', at, text: 'Answer', streaming: false },
    })
    hub.emit({ type: 'peer_thread.transcript.reset', at, botId: 'alpha', threadId: 'thread-1' })
    hub.emit({ type: 'peer_thread.removed', at, botId: 'alpha', threadId: 'thread-1' })
    const shape = (events: FleetGatewayEvent[]) =>
      events.map((event) => (event.type === 'peer_thread.transcript.upsert' ? event.item.kind : event.type))
    expect(shape(older.sent())).toEqual(['hello'])
    // A thread's reasoning goes only to devices that asked for reasoning too.
    expect(shape(threads.sent())).toEqual(['hello', 'assistant', 'peer_thread.transcript.reset', 'peer_thread.removed'])
    hub.close()
  })

  it("sends routine runs only to devices that asked for them, a run's reasoning only to those that asked for it", () => {
    const hub = new EventHub(async () => {})
    const older = subscriber()
    const runs = subscriber()
    const everything = subscriber()
    hub.add(older.response, 0, 'mac-old')
    hub.add(runs.response, 0, 'mac-runs', { routineRuns: true })
    hub.add(everything.response, 0, 'mac-new', { routineRuns: true, reasoning: true })
    const at = '2026-09-29T10:00:00.000Z'
    const upsert = (item: FleetTranscriptItem): FleetGatewayEvent => ({
      type: 'routine_run.transcript.upsert',
      at,
      botId: 'alpha',
      runId: 'run-1',
      item,
    })
    hub.emit(upsert({ kind: 'reasoning', id: 'm:0', at, text: 'Thinking', truncated: false, streaming: true }))
    hub.emit(upsert({ kind: 'assistant', id: 'm:1', at, text: 'Answer', streaming: false }))
    hub.emit({ type: 'routine_run.transcript.reset', at, botId: 'alpha', runId: 'run-1' })
    hub.emit({ type: 'routine_run.removed', at, botId: 'alpha', runId: 'run-1' })
    const shape = (events: FleetGatewayEvent[]) =>
      events.map((event) => (event.type === 'routine_run.transcript.upsert' ? event.item.kind : event.type))
    expect(shape(older.sent())).toEqual(['hello'])
    expect(shape(runs.sent())).toEqual(['hello', 'assistant', 'routine_run.transcript.reset', 'routine_run.removed'])
    expect(shape(everything.sent())).toEqual([
      'hello',
      'reasoning',
      'assistant',
      'routine_run.transcript.reset',
      'routine_run.removed',
    ])
    hub.close()
  })
})

/** A subscriber that can be closed, as a device closing its stream. */
function closable() {
  const base = subscriber()
  const closers: Array<() => void> = []
  const response = base.response as unknown as {
    destroyed: boolean
    on: (event: string, handler: () => void) => unknown
  }
  response.on = (event, handler) => {
    if (event === 'close') closers.push(handler)
    return response
  }
  return {
    ...base,
    close() {
      response.destroyed = true
      for (const close of closers) close()
    },
  }
}

describe('runner streams', () => {
  const at = '2026-10-29T10:00:00.000Z'
  const cancel: FleetGatewayEvent = { type: 'runner.cancel', at, jobId: 'job_0123456789abcdef' }
  const links: FleetGatewayEvent = { type: 'runner_link.updated', at, botId: 'alpha', links: [] }
  const types = (events: FleetGatewayEvent[]) => events.map((event) => event.type)

  it("sends runner events only to streams that read them, and a job's cancel only to its runner's newest stream", () => {
    const hub = new EventHub(async () => {})
    const older = subscriber()
    const first = subscriber()
    const second = subscriber()
    const other = subscriber()
    hub.add(older.response, 0, 'mac')
    hub.add(first.response, 0, 'mac', { runners: true })
    hub.add(second.response, 0, 'mac', { runners: true })
    hub.add(other.response, 0, 'pc', { runners: true })
    expect(hub.runnerStreamOpen('mac')).toBe(true)
    expect(hub.runnerStreamOpen('phone')).toBe(false)
    expect(hub.sendToRunner('mac', cancel)).toBe(true)
    expect(hub.sendToRunner('phone', cancel)).toBe(false)
    hub.emitToRunnerReaders(() => links)
    // Even a broadcast skips the streams that do not read runner events.
    hub.emit(links)
    expect(types(older.sent())).toEqual(['hello'])
    expect(types(first.sent())).toEqual(['hello', 'runner_link.updated', 'runner_link.updated'])
    expect(types(second.sent())).toEqual(['hello', 'runner.cancel', 'runner_link.updated', 'runner_link.updated'])
    expect(types(other.sent())).toEqual(['hello', 'runner_link.updated', 'runner_link.updated'])
    hub.close()
  })

  it('tells when a device opens or closes a stream that reads runner events', () => {
    const hub = new EventHub(async () => {})
    const changes: string[] = []
    hub.onRunnerChange = (deviceId) => changes.push(deviceId)
    const plain = closable()
    const runner = closable()
    hub.add(plain.response, 0, 'mac')
    hub.add(runner.response, 0, 'mac', { runners: true })
    expect(changes).toEqual(['mac'])
    plain.close()
    expect(changes).toEqual(['mac'])
    runner.close()
    expect(changes).toEqual(['mac', 'mac'])
    expect(hub.runnerStreamOpen('mac')).toBe(false)
    hub.close()
  })
})
