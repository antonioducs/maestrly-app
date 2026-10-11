import { describe, expect, it, vi } from 'vitest'

// The class under test takes every collaborator as a dependency; the bot singleton's wiring is not exercised here.
vi.mock('../../src/main/runtime-assets/app-service', () => ({}))

import { type ClaudeExecutable, ClaudeRuntimeSelection } from '../../src/main/chat/claude-agent-sdk/runtime-selection'
import type { RuntimeAssetLease } from '../../src/shared/runtime-assets'

const IMAGE: ClaudeExecutable = {
  path: '/opt/maestrly/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
  version: '2.1.285',
  source: 'image',
}
const managedPath = (version: string) => `/home/bot/runtime-assets/claude-code-runtime/versions/${version}/claude`

function harness(initial: { version: string } | null = null) {
  let managed = initial
  const leases: { path: string; release: ReturnType<typeof vi.fn> }[] = []
  const acquireLease = vi.fn(async (executablePath: string): Promise<RuntimeAssetLease> => {
    const release = vi.fn()
    leases.push({ path: executablePath, release })
    return { id: 'claude-code-runtime', path: executablePath, release }
  })
  const selection = new ClaudeRuntimeSelection({
    image: () => IMAGE,
    managed: async () => (managed ? { path: managedPath(managed.version), version: managed.version } : null),
    acquireLease,
  })
  return {
    selection,
    leases,
    acquireLease,
    setManaged(version: string | null) {
      managed = version ? { version } : null
    },
  }
}

describe('ClaudeRuntimeSelection', () => {
  it('uses the image runtime until a managed installation exists', async () => {
    const { selection, acquireLease } = harness()
    expect(selection.current()).toEqual(IMAGE)
    expect(await selection.refresh()).toBe(false)
    expect(selection.current().source).toBe('image')
    expect(acquireLease).not.toHaveBeenCalled()
  })

  it('switches to a managed installation newer than the image and leases it', async () => {
    const { selection, leases } = harness({ version: '2.1.290' })
    expect(await selection.refresh()).toBe(true)
    expect(selection.current()).toEqual({ path: managedPath('2.1.290'), version: '2.1.290', source: 'managed' })
    expect(leases.map((lease) => lease.path)).toEqual([managedPath('2.1.290')])
  })

  it('keeps the image when the managed installation is not newer', async () => {
    for (const version of ['2.1.285', '2.1.280']) {
      const { selection, acquireLease } = harness({ version })
      expect(await selection.refresh()).toBe(false)
      expect(selection.current().source).toBe('image')
      expect(acquireLease).not.toHaveBeenCalled()
    }
  })

  it('lets a retained turn finish on its version and releases the old lease only then', async () => {
    const { selection, leases, setManaged } = harness({ version: '2.1.290' })
    await selection.refresh()
    const turn = selection.retain()
    expect(turn.path).toBe(managedPath('2.1.290'))

    setManaged('2.1.291')
    expect(await selection.refresh()).toBe(true)
    expect(selection.current().path).toBe(managedPath('2.1.291'))
    expect(selection.retain().path).toBe(managedPath('2.1.291'))
    expect(leases[0].release).not.toHaveBeenCalled()

    turn.release()
    turn.release()
    expect(leases[0].release).toHaveBeenCalledTimes(1)
    expect(leases[1].release).not.toHaveBeenCalled()
  })

  it('lists the versions in use: the current one, and a replaced one until its last query ends', async () => {
    const { selection, setManaged } = harness({ version: '2.1.290' })
    expect(selection.inUse()).toEqual([])
    await selection.refresh()
    const managed = { path: managedPath('2.1.290'), version: '2.1.290', source: 'managed' }
    expect(selection.inUse()).toEqual([managed])

    const first = selection.retain()
    const second = selection.retain()
    setManaged(null)
    await selection.refresh()
    expect(selection.inUse()).toEqual([IMAGE, managed])
    first.release()
    expect(selection.inUse()).toEqual([IMAGE, managed])
    second.release()
    expect(selection.inUse()).toEqual([IMAGE])

    // A switch nothing was running on leaves only the new one.
    setManaged('2.1.291')
    await selection.refresh()
    expect(selection.inUse().map((executable) => executable.version)).toEqual(['2.1.291'])
  })

  it('does not over-release when one turn releases twice', async () => {
    const { selection, leases, setManaged } = harness({ version: '2.1.290' })
    await selection.refresh()
    const first = selection.retain()
    const second = selection.retain()
    setManaged(null)
    expect(await selection.refresh()).toBe(true)
    expect(selection.current()).toEqual(IMAGE)

    first.release()
    first.release()
    expect(leases[0].release).not.toHaveBeenCalled()
    second.release()
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('releases a retired lease at once when no turn uses it', async () => {
    const { selection, leases, setManaged } = harness({ version: '2.1.290' })
    await selection.refresh()
    setManaged(null)
    await selection.refresh()
    expect(leases[0].release).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent refreshes so one switch takes one lease', async () => {
    const { selection, acquireLease } = harness({ version: '2.1.290' })
    const results = await Promise.all([selection.refresh(), selection.refresh()])
    expect(results).toEqual([true, false])
    expect(acquireLease).toHaveBeenCalledTimes(1)
  })

  it('stays on the current runtime when the managed installation cannot be leased', async () => {
    const { selection, acquireLease } = harness({ version: '2.1.290' })
    acquireLease.mockRejectedValueOnce(new Error('Runtime verification failed'))
    expect(await selection.refresh()).toBe(false)
    expect(selection.current()).toEqual(IMAGE)
  })
})
