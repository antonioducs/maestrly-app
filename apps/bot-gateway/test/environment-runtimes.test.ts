import {
  fleetEnvironmentSchema,
  fleetInstanceStatusSchema,
  fleetRuntimeInfoSchema,
  type FleetInstanceStatus,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { harness } from './harness.js'

type Harness = Awaited<ReturnType<typeof harness>>

async function setup(options: { runtimes?: boolean } = { runtimes: true }) {
  const h = await harness(Date.now, { environments: true, ...options })
  return { h, environmentId: h.bot.environmentId! }
}
const json = async (response: Response) => (await response.json()) as Record<string, unknown>
const updateStatus = (h: Harness, status: FleetInstanceStatus) =>
  (h.lifecycle as unknown as { updateStatus(id: string, status: FleetInstanceStatus): void }).updateStatus(
    h.bot.id,
    status
  )
const environmentEvents = (h: Harness) => h.events.filter((event) => event.type === 'environment.updated').length

describe('environment runtimes', () => {
  it('preserves additional runtimes through status, public views and events without breaking legacy readers', async () => {
    const { h, environmentId } = await setup()
    const status = h.lifecycle.statuses.get(h.bot.id)!
    const additional = { ...status.runtimes![0], id: 'antigravity-acp' as const, version: '1.2.2' }
    const wire = { ...status, additionalRuntimes: [additional] }
    const legacyRuntimes = z.array(fleetRuntimeInfoSchema.extend({ id: z.enum(['claude-code', 'codex']) })).nullable()
    const legacyStatus = fleetInstanceStatusSchema
      .omit({ additionalRuntimes: true })
      .extend({ runtimes: legacyRuntimes })
    const legacyEnvironment = fleetEnvironmentSchema
      .omit({ additionalRuntimes: true })
      .extend({ runtimes: legacyRuntimes })
    expect(legacyStatus.parse(wire).runtimes).toEqual(status.runtimes)
    expect(legacyStatus.parse(wire)).not.toHaveProperty('additionalRuntimes')
    const before = environmentEvents(h)
    updateStatus(h, fleetInstanceStatusSchema.parse(wire))
    expect(environmentEvents(h)).toBe(before + 1)
    const view = await json(await h.request('GET', '/v1/environments/' + environmentId))
    expect(view.additionalRuntimes).toEqual([additional])
    expect(legacyEnvironment.parse(view).runtimes).toEqual(status.runtimes)
    expect(legacyEnvironment.parse(view)).not.toHaveProperty('additionalRuntimes')
    const event = h.events.filter((item) => item.type === 'environment.updated').at(-1)
    expect(event?.type).toBe('environment.updated')
    if (event?.type !== 'environment.updated') throw new Error('Missing environment update')
    expect(event.environment.additionalRuntimes).toEqual([additional])
    expect(legacyEnvironment.parse(event.environment).runtimes).toEqual(status.runtimes)
    updateStatus(h, wire)
    expect(environmentEvents(h)).toBe(before + 1)
    updateStatus(h, { ...status, runtimes: null })
    expect(h.lifecycle.environment(environmentId)?.additionalRuntimes).toEqual([additional])
    updateStatus(h, { ...wire, additionalRuntimes: [{ ...additional, state: 'checking' }] })
    expect(environmentEvents(h)).toBe(before + 2)
    expect(h.lifecycle.environment(environmentId)?.additionalRuntimes?.[0].state).toBe('checking')
    updateStatus(h, { ...wire, additionalRuntimes: [] })
    expect(h.lifecycle.environment(environmentId)?.additionalRuntimes).toEqual([])
  })

  it('projects the runtimes its bots report and emits them only when they change', async () => {
    const { h, environmentId } = await setup()
    const reported = h.instance.provisioning.runtimes!
    expect(h.lifecycle.environment(environmentId)?.runtimes).toEqual(reported)
    const view = await json(await h.request('GET', '/v1/environments/' + environmentId))
    expect(view.runtimes).toEqual(reported)

    const status = h.lifecycle.statuses.get(h.bot.id)!
    const before = environmentEvents(h)
    updateStatus(h, { ...status })
    expect(environmentEvents(h)).toBe(before)

    const checking = reported.map((runtime) =>
      runtime.id === 'claude-code' ? { ...runtime, state: 'checking' as const } : runtime
    )
    updateStatus(h, { ...status, runtimes: checking })
    expect(environmentEvents(h)).toBe(before + 1)
    const event = h.events.filter((item) => item.type === 'environment.updated').at(-1)
    expect(event?.type === 'environment.updated' && event.environment.runtimes).toEqual(checking)
  })

  it('keeps the last known runtimes when a status reports none', async () => {
    const { h, environmentId } = await setup()
    const status = h.lifecycle.statuses.get(h.bot.id)!
    updateStatus(h, { ...status, runtimes: null })
    expect(h.lifecycle.environment(environmentId)?.runtimes).toEqual(h.instance.provisioning.runtimes)
  })

  it('reports no runtimes for an environment whose image predates them', async () => {
    const { h, environmentId } = await setup({})
    expect(h.lifecycle.environment(environmentId)?.runtimes).toBeNull()
  })

  it('forwards a runtime check to a running environment and answers the environment', async () => {
    const { h, environmentId } = await setup()
    const response = await h.request('POST', '/v1/environments/' + environmentId + '/runtimes/check')
    expect(response.status).toBe(200)
    expect((await json(response)).id).toBe(environmentId)
    expect(h.instance.control.runtimeChecks).toBe(1)
  })

  it('refuses a check the environment cannot run', async () => {
    const legacy = await setup({})
    const refused = await legacy.h.request('POST', '/v1/environments/' + legacy.environmentId + '/runtimes/check')
    expect(refused.status).toBe(409)
    expect((await json(refused)).code).toBe('CONFLICT')
    expect(legacy.h.instance.control.runtimeChecks).toBe(0)

    const { h, environmentId } = await setup()
    await h.lifecycle.stopEnvironment(environmentId)
    const stopped = await h.request('POST', '/v1/environments/' + environmentId + '/runtimes/check')
    expect((await json(stopped)).code).toBe('BOT_NOT_RUNNING')
    expect(h.instance.control.runtimeChecks).toBe(0)
    const missing = await h.request('POST', '/v1/environments/nope/runtimes/check')
    expect(missing.status).toBe(404)
  })

  it('advertises runtime updates', async () => {
    const { h } = await setup()
    const meta = await json(await h.request('GET', '/v1/meta'))
    expect(meta.features).toContain('runtime-updates')
  })
})
