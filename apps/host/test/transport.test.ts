import { describe, it, expect } from 'vitest'
import { FrameDecoder, handleFrame, MAX_FRAME_BYTES } from '../src/transport.js'
import { assessDoctor } from '../src/doctor.js'
describe('private bounded RPC', () => {
  it('handles split Unicode frames and rejects oversized input', () => {
    const d = new FrameDecoder()
    const bytes = Buffer.from('{"name":"é"}\n')
    expect(d.push(bytes.subarray(0, 10))).toEqual([])
    expect(d.push(bytes.subarray(10))).toEqual(['{"name":"é"}'])
    expect(() => d.push(Buffer.alloc(MAX_FRAME_BYTES + 1))).toThrow()
  })
  it('validates requests before dispatch and hides unexpected errors', async () => {
    let calls = 0
    const dispatch = async () => {
      calls++
      throw Error('/secret/host/path credentials')
    }
    expect((await handleFrame('{', dispatch)).error?.code).toBe('INVALID_REQUEST')
    expect(calls).toBe(0)
    const response = await handleFrame(
      JSON.stringify({ version: 1, id: 'test', method: 'host.inspect', params: {} }),
      dispatch
    )
    expect(response.error?.message).toBe('Host request failed')
    expect(JSON.stringify(response)).not.toContain('secret')
  })
  it('rejects unknown methods and extra parameters', async () => {
    const dispatch = async () => {
      throw Error('must not dispatch')
    }
    for (const request of [
      { version: 1, id: 'x', method: 'exec', params: {} },
      { version: 1, id: 'x', method: 'host.inspect', params: { path: '/tmp' } },
    ])
      expect((await handleFrame(JSON.stringify(request), dispatch)).error?.code).toBe('INVALID_REQUEST')
  })
})
const facts = {
  platform: 'darwin',
  processArch: 'arm64',
  physicalArch: 'arm64',
  translated: false,
  model: 'Mac14,12',
  macOS: '14.5',
  identity: '12345678-1234-1234-1234-123456789ABC',
  memoryMiB: 16384,
  freeDiskGiB: 100,
  hvf: true,
  physicalCpus: 8,
  fileVault: null,
  sleepMinutes: null,
  runtimeSmoke: true,
}
describe('doctor evidence', () => {
  it('requires actual HVF smoke', () => {
    expect(assessDoctor(facts).status).toBe('supported')
    expect(assessDoctor({ ...facts, runtimeSmoke: null }).status).toBe('needs_action')
    expect(assessDoctor({ ...facts, runtimeSmoke: false }).status).toBe('blocked')
    expect(assessDoctor({ ...facts, hvf: null }).status).toBe('needs_action')
    expect(assessDoctor({ ...facts, hvf: false }).status).toBe('blocked')
  })
  it('blocks virtual machines and translation', () => {
    expect(assessDoctor({ ...facts, model: 'VirtualMac2,1' }).status).toBe('blocked')
    expect(assessDoctor({ ...facts, translated: true }).status).toBe('blocked')
  })
  it('does not infer missing hardware facts', () => {
    expect(assessDoctor({ ...facts, identity: null }).status).toBe('needs_action')
    expect(assessDoctor({ ...facts, platform: 'linux' }).status).toBe('blocked')
  })
})
it('sanitizes durable operation and event errors too', async () => {
  const request = JSON.stringify({ version: 1, id: 'event', method: 'events.list', params: {} })
  const response = await handleFrame(request, async () => ({
    version: 1,
    id: 'event',
    result: [{ value: { error: { code: 'PROVIDER_ERROR', message: '/private/key secret' } } }],
  }))
  expect(JSON.stringify(response)).not.toContain('/private/key')
  expect(JSON.stringify(response)).not.toContain('secret')
})
