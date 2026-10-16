import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import { ArtifactOpenError, artifactLink, artifactPublication, artifactViewerBase } from '../src/artifacts/artifacts'
import { transcriptRows } from '../src/fleet/transcript-rows'
import { GatewayError, type GatewayClient } from '../src/gateway/client'

type Tool = Extract<FleetTranscriptItem, { kind: 'tool' }>
const ID = 'AbCdEfGhIjKlMnOpQrStUv'
const output = (title: string, version = 2) =>
  JSON.stringify({
    ok: true,
    artifact: { id: ID, title, version },
    skipped: [],
    note: 'The user can open it from the chat card or the Artifacts center.',
  })
const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  id: `t-${name}`,
  at: '2026-10-13T12:00:00.000Z',
  kind: 'tool',
  name,
  target: null,
  state: 'done',
  output: output('Pricing page'),
  images: [],
  ...extra,
})

describe('artifacts', () => {
  it('finds the page a finished publication made, whatever prefix the runtime puts on the tool', () => {
    expect(artifactPublication(tool('artifact_create'))).toEqual({ id: ID, title: 'Pricing page', version: 2 })
    expect(artifactPublication(tool('mcp__maestrly__artifact_update'))?.version).toBe(2)
    expect(artifactPublication(tool('artifact_get'))).toBeNull()
    expect(artifactPublication(tool('artifact_create', { state: 'running' }))).toBeNull()
    expect(artifactPublication(tool('artifact_create', { output: '{"ok":false,"error":"x"}' }))).toBeNull()
    expect(artifactPublication(tool('artifact_create', { output: 'Published.' }))).toBeNull()
  })

  it('reads a result the transcript cut short, and an escaped title', () => {
    const long = output('A "quoted" title — with ünicode', 7).slice(0, 120)
    expect(artifactPublication(tool('artifact_create', { output: long }))).toEqual({
      id: ID,
      title: 'A "quoted" title — with ünicode',
      version: 7,
    })
    const bad = output('x').replace(ID, 'short')
    expect(artifactPublication(tool('artifact_create', { output: bad }))).toBeNull()
  })

  it('shows a publication as its own card, outside the activity', () => {
    const rows = transcriptRows([tool('bash'), tool('artifact_create'), tool('read')])
    expect(rows.map((row) => row.kind)).toEqual(['artifact', 'activity'])
  })

  it('opens the viewer at the server public HTTPS address, or on loopback in development', () => {
    const base = { origin: 'https://bots.example.dev', features: ['artifacts-gateway-viewer'], allowLoopback: false }
    expect(artifactViewerBase({ ...base, publicAddress: 'https://bots.example.dev' })).toBe('https://bots.example.dev')
    expect(artifactViewerBase({ ...base, publicAddress: 'https://pages.example.dev:8443' })).toBe(
      'https://pages.example.dev:8443'
    )
    expect(artifactViewerBase({ ...base, publicAddress: 'http://pages.example.dev' })).toBeNull()
    expect(artifactViewerBase({ ...base, publicAddress: '' })).toBeNull()
    const local = { origin: 'http://127.0.0.1:7443', publicAddress: '', allowLoopback: true }
    expect(artifactViewerBase({ ...local, features: ['artifacts-gateway-viewer'] })).toBe('http://127.0.0.1:7443')
    expect(artifactViewerBase({ ...local, features: [] })).toBeNull()
    expect(artifactViewerBase({ ...local, allowLoopback: false, features: ['artifacts-gateway-viewer'] })).toBeNull()
  })

  it('opens a version with a single-use ticket in the fragment', async () => {
    const calls: unknown[] = []
    const host = (enabled = true, publicAddress = 'https://bots.example.dev') => ({
      settings: { enabled, publicAddress, ownerName: '', linkExpiryDays: null, quotaGb: 2 },
      status: { state: 'running', problem: null, artifactCount: 1, storageBytes: 1, quotaBytes: 2 },
    })
    const client = (answers: Record<string, unknown>) =>
      ({
        call: vi.fn(async (key: string, options?: { body?: unknown }) => {
          calls.push([key, options?.body])
          const answer = answers[key]
          if (answer instanceof Error) throw answer
          return answer
        }),
      }) as unknown as GatewayClient
    const server = { origin: 'https://bots.example.dev', features: ['artifacts', 'artifacts-gateway-viewer'] }
    const ticket = { ok: true, value: { ticket: 'tk/+=', expiresAt: 1 } }

    const link = await artifactLink(
      client({ artifactHost: host(), artifactAdmin: ticket }),
      server,
      { id: ID, version: 3 },
      false
    )
    expect(link).toBe(`https://bots.example.dev/a/${ID}#o=tk%2F%2B%3D&v=3`)
    expect(calls).toContainEqual(['artifactAdmin', { method: 'mintOwnerTicket', args: [ID] }])

    const issue = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: unknown) => (error instanceof ArtifactOpenError ? error.issue : 'other')
      )
    const open = (answers: Record<string, unknown>, features = server.features) =>
      issue(artifactLink(client(answers), { ...server, features }, { id: ID, version: 1 }, false))
    expect(await open({}, [])).toBe('unsupported')
    expect(await open({ artifactHost: host(false) })).toBe('off')
    expect(await open({ artifactHost: host(true, '') })).toBe('noAddress')
    expect(
      await open({
        artifactHost: host(),
        artifactAdmin: { ok: false, error: { code: 'not_found', message: 'gone' } },
      })
    ).toBe('gone')
    expect(await open({ artifactHost: new GatewayError('NETWORK', 0, 'down') })).toBe('offline')
    expect(await open({ artifactHost: new GatewayError('NOT_FOUND', 404, 'old') })).toBe('unsupported')
  })
})
