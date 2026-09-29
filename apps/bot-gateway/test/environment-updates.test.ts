import { describe, expect, it } from 'vitest'
import { GatewayError } from '../src/errors.js'
import { Lifecycle } from '../src/lifecycle.js'
import { harness } from './harness.js'

type Harness = Awaited<ReturnType<typeof harness>>
const NEW_IMAGE = 'sha256:' + 'b'.repeat(64)

async function setup() {
  const h = await harness(Date.now, { environments: true })
  const environmentId = h.bot.environmentId!
  return { h, environmentId }
}
/** The configured bot image now names another image than the one the environment's container runs. */
const outdate = (h: Harness) => h.docker.setImage(h.lifecycle.config.botImage, NEW_IMAGE)
const containerOf = (h: Harness, environmentId: string) => {
  const name = h.store.getEnvironment(environmentId)!.containerName
  return [...h.docker.containers.values()].find((item) => item.name === name)
}
const status = (h: Harness) => h.lifecycle.statuses.get(h.bot.id)!
const busy = (h: Harness) => {
  status(h).turn = { ...status(h).turn, state: 'running' }
}
const idle = (h: Harness) => {
  status(h).turn = { ...status(h).turn, state: 'idle' }
}
const restarts = (h: Harness, environmentId: string) =>
  h.store.activity().filter((entry) => entry.kind === 'environment_restarted' && entry.environmentId === environmentId)
function codeOf(error: unknown): string | null {
  return error instanceof GatewayError ? error.code : null
}

describe('environment updates', () => {
  it('schedules nothing when the environment already runs the configured image', async () => {
    const { h, environmentId } = await setup()
    const before = containerOf(h, environmentId)
    const view = await h.lifecycle.scheduleUpdate(environmentId)
    expect(view.update).toEqual({ available: false, pendingSince: null })
    expect(h.store.getEnvironment(environmentId)!.updateRequestedAt).toBeNull()
    await h.lifecycle.checkUpdates()
    expect(containerOf(h, environmentId)).toBe(before)
  })

  it('waits while a bot works, then updates once it is idle', async () => {
    const { h, environmentId } = await setup()
    const before = containerOf(h, environmentId)!
    outdate(h)
    busy(h)
    expect(h.lifecycle.get(h.bot.id)?.status).toBe('working')
    const view = await h.lifecycle.scheduleUpdate(environmentId)
    expect(view.update?.available).toBe(true)
    expect(view.update?.pendingSince).toEqual(expect.any(String))
    expect(h.lifecycle.environment(environmentId)?.update).toEqual(view.update)
    await h.lifecycle.checkUpdates()
    expect(containerOf(h, environmentId)).toBe(before)
    expect(h.lifecycle.busyBots(environmentId)).toEqual([h.bot.id])
    expect(h.lifecycle.updatePending(h.bot.id)).toBe(true)
    // Scheduling again keeps the first request.
    const again = await h.lifecycle.scheduleUpdate(environmentId)
    expect(again.update?.pendingSince).toBe(view.update?.pendingSince)

    idle(h)
    await h.lifecycle.checkUpdates()
    const after = containerOf(h, environmentId)!
    expect(after).not.toBe(before)
    expect(after.imageId).toBe(NEW_IMAGE)
    expect(h.store.getEnvironment(environmentId)).toMatchObject({ lifecycle: 'running', updateRequestedAt: null })
    expect(h.lifecycle.environment(environmentId)?.update).toEqual({ available: false, pendingSince: null })
    expect(h.lifecycle.updatePending(h.bot.id)).toBe(false)
    expect(h.lifecycle.get(h.bot.id)?.lifecycle).toBe('running')
    expect(restarts(h, environmentId).at(-1)?.data).toMatchObject({ updated: true, toImage: 'bbbbbbbbbbbb' })
  })

  it('updates right away when every bot is already idle', async () => {
    const { h, environmentId } = await setup()
    outdate(h)
    const view = await h.lifecycle.scheduleUpdate(environmentId)
    // It answers before the restart: the update is scheduled, not done.
    expect(view.update?.pendingSince).toEqual(expect.any(String))
    await h.lifecycle.checkUpdates()
    await expect.poll(() => containerOf(h, environmentId)?.imageId).toBe(NEW_IMAGE)
    await expect.poll(() => h.store.getEnvironment(environmentId)?.lifecycle).toBe('running')
    expect(h.store.getEnvironment(environmentId)?.updateRequestedAt).toBeNull()
  })

  it('waits for a bot that waits for its owner or whose screen the owner controls, not for a paused one', async () => {
    const { h, environmentId } = await setup()
    const before = containerOf(h, environmentId)!
    outdate(h)
    status(h).pending = [
      { kind: 'question', id: 'q1', title: 'Pick one', questions: [], createdAt: new Date().toISOString() },
    ] as never
    expect(h.lifecycle.get(h.bot.id)?.status).toBe('waiting')
    await h.lifecycle.scheduleUpdate(environmentId)
    await h.lifecycle.checkUpdates()
    expect(containerOf(h, environmentId)).toBe(before)

    status(h).pending = []
    status(h).hold = { state: 'held', reason: 'takeover', since: new Date().toISOString(), interruptedTurn: false }
    expect(h.lifecycle.get(h.bot.id)?.status).toBe('human')
    await h.lifecycle.checkUpdates()
    expect(containerOf(h, environmentId)).toBe(before)

    // A paused bot starts no turn on its own, and its queue survives the restart.
    status(h).hold = { state: 'held', reason: 'paused', since: new Date().toISOString(), interruptedTurn: false }
    status(h).queue = [{ inputId: 'queued-input', source: 'owner', preview: 'Later' }] as never
    expect(h.lifecycle.get(h.bot.id)?.status).toBe('paused')
    await h.lifecycle.checkUpdates()
    expect(containerOf(h, environmentId)?.imageId).toBe(NEW_IMAGE)
    expect(h.store.getEnvironment(environmentId)?.updateRequestedAt).toBeNull()
  })

  it('updates now while a bot works, and cancels a waiting update', async () => {
    const { h, environmentId } = await setup()
    const before = containerOf(h, environmentId)!
    outdate(h)
    busy(h)
    await h.lifecycle.scheduleUpdate(environmentId)
    const cancelled = await h.lifecycle.cancelUpdate(environmentId)
    expect(cancelled.update).toEqual({ available: true, pendingSince: null })
    busy(h)
    idle(h)
    await h.lifecycle.checkUpdates()
    expect(containerOf(h, environmentId)).toBe(before)

    busy(h)
    await h.lifecycle.scheduleUpdate(environmentId)
    const updated = await h.lifecycle.updateNow(environmentId)
    expect(updated.update).toEqual({ available: false, pendingSince: null })
    expect(updated.lifecycle).toBe('running')
    expect(containerOf(h, environmentId)?.imageId).toBe(NEW_IMAGE)
    expect(h.store.getEnvironment(environmentId)?.updateRequestedAt).toBeNull()
  })

  it('forgets a waiting update when the environment stops, and schedules none for a stopped environment', async () => {
    const { h, environmentId } = await setup()
    outdate(h)
    busy(h)
    await h.lifecycle.scheduleUpdate(environmentId)
    await h.lifecycle.stopEnvironment(environmentId)
    expect(h.store.getEnvironment(environmentId)?.updateRequestedAt).toBeNull()
    const error = await h.lifecycle.scheduleUpdate(environmentId).catch((cause: unknown) => cause)
    expect(codeOf(error)).toBe('BOT_NOT_RUNNING')
    expect(codeOf(await h.lifecycle.scheduleUpdate('missing').catch((cause: unknown) => cause))).toBe('NOT_FOUND')
    expect(codeOf(await h.lifecycle.cancelUpdate('missing').catch((cause: unknown) => cause))).toBe('NOT_FOUND')
    // Starting it again moves it to the configured image anyway.
    await h.lifecycle.startEnvironment(environmentId)
    expect(containerOf(h, environmentId)?.imageId).toBe(NEW_IMAGE)
  })

  it('forgets a waiting update when the environment is archived', async () => {
    const { h, environmentId } = await setup()
    outdate(h)
    busy(h)
    await h.lifecycle.scheduleUpdate(environmentId)
    await h.lifecycle.archiveEnvironment(environmentId)
    expect(h.store.getEnvironment(environmentId)?.updateRequestedAt).toBeNull()
  })

  it('keeps a waiting update across a gateway restart, and drops one that no longer has an update', async () => {
    const { h, environmentId } = await setup()
    const original = containerOf(h, environmentId)!.imageId
    outdate(h)
    busy(h)
    await h.lifecycle.scheduleUpdate(environmentId)
    const restarted = () =>
      new Lifecycle(h.store, h.lifecycle.docker, h.lifecycle.config, h.lifecycle.instance, h.lifecycle.healthTimeoutMs)

    // The configured image went back to the one the container runs: nothing is left to update.
    h.docker.setImage(h.lifecycle.config.botImage, original)
    const first = restarted()
    try {
      await first.reconcile()
      expect(h.store.getEnvironment(environmentId)?.updateRequestedAt).toBeNull()
    } finally {
      first.close()
    }

    outdate(h)
    await h.lifecycle.scheduleUpdate(environmentId)
    const pendingSince = h.store.getEnvironment(environmentId)?.updateRequestedAt
    expect(pendingSince).toEqual(expect.any(String))
    const second = restarted()
    try {
      await second.reconcile()
      expect(second.environment(environmentId)?.update).toEqual({ available: true, pendingSince })
      // Its bots came back idle from the reinstall: the update goes on.
      await second.checkUpdates()
      expect(containerOf(h, environmentId)?.imageId).toBe(NEW_IMAGE)
      expect(h.store.getEnvironment(environmentId)?.updateRequestedAt).toBeNull()
    } finally {
      second.close()
    }
  })
})
