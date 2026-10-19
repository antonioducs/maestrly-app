import type { FleetDictationTranscribeRequest, FleetDictationTranscribeResponse } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import { levelFromDb, serverRecordingEngine } from '../src/dictation/server-engine'
import { GatewayError } from '../src/gateway/client'

const recording = { uri: 'file:///cache/rec.m4a', peakDb: -20 }

type Transcribe = (body: FleetDictationTranscribeRequest) => Promise<FleetDictationTranscribeResponse>

function engine(transcribe = vi.fn<Transcribe>(async () => ({ text: 'olá' }))) {
  const deleteFile = vi.fn()
  const readBase64 = vi.fn(async () => 'YWJj')
  const recorder = {
    requestPermission: vi.fn(async () => true),
    start: vi.fn(async (onLevelDb: (db: number) => void) => onLevelDb(-30)),
    stop: vi.fn(async () => recording),
    abort: vi.fn(),
  }
  return {
    recorder,
    deleteFile,
    readBase64,
    transcribe,
    engine: serverRecordingEngine({ recorder, transcribe, readBase64, deleteFile }),
  }
}

describe('server dictation engine', () => {
  it('sends the recording as base64 M4A in the language asked', async () => {
    const { engine: server, transcribe, readBase64 } = engine()
    expect(await server.transcribe(recording, 'pt')).toEqual({ text: 'olá' })
    expect(readBase64).toHaveBeenCalledWith('file:///cache/rec.m4a')
    expect(transcribe).toHaveBeenCalledWith({ audio: 'YWJj', mediaType: 'audio/mp4', language: 'pt' })
  })

  it("passes the server's errors on, and tells a failure to reach it as unavailable", async () => {
    const refused = engine(vi.fn<Transcribe>(async () => ({ error: 'key-rejected' })))
    expect(await refused.engine.transcribe(recording, null)).toEqual({ error: 'key-rejected' })
    for (const code of ['NETWORK', 'TIMEOUT', 'INTERNAL'] as const) {
      const offline = engine(
        vi.fn<Transcribe>(async () => {
          throw new GatewayError(code, 0, 'down')
        })
      )
      expect(await offline.engine.transcribe(recording, null)).toEqual({ error: 'unavailable' })
    }
  })

  it('deletes a recording it is done with', () => {
    const { engine: server, deleteFile } = engine()
    server.discard(recording)
    expect(deleteFile).toHaveBeenCalledWith('file:///cache/rec.m4a')
  })

  it('turns the recorder level into the indicator level', async () => {
    expect(levelFromDb(-60)).toBe(0)
    expect(levelFromDb(-160)).toBe(0)
    expect(levelFromDb(0)).toBe(1)
    expect(levelFromDb(-30)).toBe(0.5)
    const { engine: server } = engine()
    const levels: number[] = []
    await server.start((level) => levels.push(level))
    expect(levels).toEqual([0.5])
  })
})
