import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createDialogSuppressionLeases } from '../../src/main/drawer/dialog-suppression'

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

describe('Dialog suppression leases', () => {
  it('keeps independent renderers leased until each one closes', () => {
    const snapshots: number[][] = []
    const leases = createDialogSuppressionLeases((ids) => snapshots.push([...ids].sort((a, b) => a - b)))
    const first = new FakeSender(11)
    const second = new FakeSender(22)

    leases.update(first as never, true)
    leases.update(second as never, true)
    leases.update(first as never, false)

    expect(snapshots).toEqual([[11], [11, 22], [22]])
    expect([...leases.ownerIds()]).toEqual([22])
  })

  it('is idempotent per renderer and releases a dead renderer automatically', () => {
    const onChange = vi.fn()
    const leases = createDialogSuppressionLeases(onChange)
    const sender = new FakeSender(33)

    leases.update(sender as never, true)
    leases.update(sender as never, true)
    expect(onChange).toHaveBeenCalledTimes(1)

    sender.emit('destroyed')

    expect(onChange).toHaveBeenLastCalledWith(new Set())
    expect(leases.ownerIds().size).toBe(0)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })

  it('removes the destroyed listener after a normal close', () => {
    const onChange = vi.fn()
    const leases = createDialogSuppressionLeases(onChange)
    const sender = new FakeSender(44)

    leases.update(sender as never, true)
    leases.update(sender as never, false)
    sender.emit('destroyed')

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })

  it('releases on renderer crash or main-frame reload, but not on a subframe navigation', () => {
    const snapshots: number[][] = []
    const leases = createDialogSuppressionLeases((ids) => snapshots.push([...ids]))
    const crashed = new FakeSender(55)
    const reloaded = new FakeSender(66)

    leases.update(crashed as never, true)
    crashed.emit('render-process-gone')
    leases.update(reloaded as never, true)
    reloaded.emit('did-start-navigation', {}, 'https://frame.test', false, false)
    expect([...leases.ownerIds()]).toEqual([66])

    reloaded.emit('did-start-navigation', {}, 'file:///panel.html', false, true)

    expect(leases.ownerIds().size).toBe(0)
    expect(snapshots.at(-1)).toEqual([])
  })
})
