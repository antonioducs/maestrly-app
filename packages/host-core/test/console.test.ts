import { describe, expect, it, vi } from 'vitest'
import { buildQemuArgs } from '../src/providers/qemu/arguments.js'
import type { Vm } from '@maestrly/host-protocol'
import type { Runtime } from '../src/provider.js'
describe('bounded headless guest console', () => {
  it('provides an emulated UART while keeping console output in a bounded private ring', () => {
    const vm = {
      id: '11111111-1111-4111-8111-111111111111',
      identity: '22222222-2222-4222-8222-222222222222',
      cpus: 1,
      memoryMiB: 1024,
    } as Vm
    const args = buildQemuArgs(vm, { arch: 'arm64' } as Runtime, {
      directory: '/private/tmp/test',
      disk: '/private/tmp/test/disk',
      seed: '/private/tmp/test/seed',
      qmp: '/private/tmp/test/qmp',
      qga: '/private/tmp/test/qga',
      firmwareVars: '/private/tmp/test/vars',
      log: '/private/tmp/test/log',
    })
    expect(args[args.indexOf('-serial') + 1]).toBe('chardev:console0')
    expect(args).toContain('ringbuf,id=console0,size=65536')
    expect(args).not.toContain('stdio')
    expect(args).toContain('none')
  })
})

it('bounds and sanitizes console output and closes the private monitor', async () => {
  const { QemuProvider } = await import('../src/provider.js')
  const provider = new QemuProvider('/private/tmp/console-fixture')
  const channel = {
    command: vi
      .fn()
      .mockResolvedValue(Array.from({ length: 250 }, () => '\u001b[31mboot\u0000 ' + 'x'.repeat(3000)).join('\n')),
    close: vi.fn(),
  }
  vi.spyOn(provider as any, 'monitor').mockResolvedValue(channel)
  await expect(provider.logs({} as Vm)).rejects.toThrow('Invalid guest console')
  expect(channel.close).toHaveBeenCalledTimes(1)
  channel.command.mockResolvedValue(Array.from({ length: 220 }, () => '\u001b[31mline\u0000').join('\n'))
  const lines = await provider.logs({} as Vm)
  expect(lines).toHaveLength(200)
  expect(lines.join('\n')).not.toMatch(/[\u001b\u0000]/)
  expect(channel.command).toHaveBeenLastCalledWith('ringbuf-read', { device: 'console0', size: 65536, format: 'utf8' })
  expect(channel.close).toHaveBeenCalledTimes(2)
})
