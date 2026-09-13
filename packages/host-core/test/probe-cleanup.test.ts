import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ child: undefined as any }))
vi.mock('node:child_process', () => ({ spawn: () => fixture.child }))
import { probeHvf } from '../src/providers/qemu/probe.js'
// The disposable probe uses a POSIX /tmp directory and Unix socket path.
const skipWindows = process.platform === 'win32'
it.skipIf(skipWindows)(
  'stops its own disposable probe process when QMP never appears',
  async () => {
    const child = new EventEmitter() as any
    child.kill = vi.fn(() => {
      child.emit('exit', 0)
      return true
    })
    child.unref = vi.fn()
    fixture.child = child
    await expect(probeHvf('/verified/test-fixture', 'arm64', 20)).rejects.toThrow('HVF smoke')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.unref).not.toHaveBeenCalled()
  },
  10000
)
