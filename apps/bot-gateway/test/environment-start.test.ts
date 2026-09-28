import { describe, expect, it, vi } from 'vitest'
import { DockerError } from '../src/docker.js'
import { harness } from './harness.js'

describe('environment startup recovery', () => {
  it('sends the current pause with installation before a stopped environment can dispatch work', async () => {
    const h = await harness(Date.now, { environments: true })
    const id = h.bot.environmentId!
    await h.lifecycle.stopEnvironment(id)
    await h.lifecycle.pause(h.bot.id)
    h.instance.installs.length = 0
    await h.lifecycle.startEnvironment(id)
    expect(h.instance.installs).toEqual([
      expect.objectContaining({ profile: expect.objectContaining({ botId: h.bot.id }), paused: true }),
    ])
  })

  it('rechecks a failed environment whose container is already running without starting or restarting it', async () => {
    const h = await harness(Date.now, { environments: true })
    const id = h.bot.environmentId!
    const before = await h.lifecycle.docker.list()
    h.store.updateEnvironment(id, { lifecycle: 'failed' })
    const start = vi.spyOn(h.lifecycle.docker, 'start').mockRejectedValue(new DockerError(304, 'Already started'))
    const restart = vi.spyOn(h.lifecycle.docker, 'restart')
    const response = await h.request('POST', `/v1/environments/${id}/start`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id, lifecycle: 'running' })
    expect(h.lifecycle.get(h.bot.id)?.lifecycle).toBe('running')
    expect(start).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect(await h.lifecycle.docker.list()).toEqual(before)
  })
})
