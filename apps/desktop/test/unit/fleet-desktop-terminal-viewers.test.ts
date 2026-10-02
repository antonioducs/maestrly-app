import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TerminalViewers, xdotoolActivate } from '../../src/main/fleet/instance/desktop/terminal-viewers'

interface FakeChild {
  command: string
  args: string[]
  env: Record<string, string>
  pid: number
  exit(code?: number | null): void
  kill: ReturnType<typeof vi.fn<(signal?: 'SIGTERM' | 'SIGKILL') => void>>
}

const ENV = {
  DISPLAY: ':3',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/home/bot/.cache/maestrly-bots/alpha/bus',
  MAESTRLY_DESKTOP_SOCKET: '/home/bot/.cache/maestrly-bots/alpha/desktop.sock',
}

function harness(
  options: { max?: number; activate?: (pid: number) => Promise<boolean>; pid?: number | undefined } = {}
) {
  const children: FakeChild[] = []
  const log = vi.fn()
  const activate = vi.fn(options.activate ?? (async () => true))
  let nextPid = 500
  const viewers = new TerminalViewers({
    env: ENV,
    spawn: (command, args, spawnOptions) => {
      let resolveExit: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((resolve) => {
        resolveExit = resolve
      })
      const pid = 'pid' in options ? options.pid : nextPid++
      const child: FakeChild = {
        command,
        args,
        env: spawnOptions.env,
        pid: pid ?? 0,
        exit: (code = 0) => resolveExit(code),
        kill: vi.fn((_signal?: 'SIGTERM' | 'SIGKILL') => resolveExit(null)),
      }
      children.push(child)
      return { pid, exited, kill: child.kill }
    },
    activate,
    log,
    ...(options.max === undefined ? {} : { max: options.max }),
  })
  return { viewers, children, activate, log }
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

describe('TerminalViewers', () => {
  it('opens an xterm that attaches to the pty', async () => {
    const { viewers, children } = harness()
    await viewers.show('term:conv:1', 'Terminal 1')
    expect(children).toHaveLength(1)
    expect(children[0].command).toBe('xterm')
    expect(children[0].args).toEqual([
      '-class',
      'Maestrly-Terminal',
      '-T',
      'Terminal 1',
      '-fa',
      'DejaVu Sans Mono',
      '-fs',
      '11',
      '-bg',
      '#0b0b0d',
      '-fg',
      '#d8d5cc',
      '-geometry',
      '104x30',
      '-xrm',
      'XTerm*allowTitleOps: false',
      '-e',
      '/usr/local/bin/maestrly-pty-attach',
    ])
    expect(children[0].env).toEqual({ ...ENV, MAESTRLY_PTY_ID: 'term:conv:1' })
  })

  it('does not let a title become an option or carry control characters', async () => {
    const { viewers, children } = harness()
    await viewers.show('term:conv:1', '-e rm\x1b[31m\n' + 'x'.repeat(300))
    const title = children[0].args[children[0].args.indexOf('-T') + 1]
    expect(title).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(title.length).toBeLessThanOrEqual(80)
    expect(children[0].args.indexOf('-T') + 2).toBe(children[0].args.indexOf('-fa'))
    await viewers.show('term:conv:2', '')
    expect(children[1].args[children[1].args.indexOf('-T') + 1]).not.toBe('')
  })

  it('activates the window of an existing viewer instead of opening another', async () => {
    const { viewers, children, activate } = harness()
    await viewers.show('term:conv:1', 'Terminal 1')
    await viewers.show('term:conv:1', 'Terminal 1')
    expect(children).toHaveLength(1)
    expect(activate).toHaveBeenCalledExactlyOnceWith(500)
  })

  it('opens one viewer for simultaneous requests for the same pty', async () => {
    const { viewers, children } = harness()
    await Promise.all([
      viewers.show('term:conv:1', 'a'),
      viewers.show('term:conv:1', 'a'),
      viewers.show('term:conv:1', 'a'),
    ])
    expect(children).toHaveLength(1)
  })

  it('keeps a viewer whose window cannot be activated yet and does not open another', async () => {
    const { viewers, children, log } = harness({ activate: async () => false })
    await viewers.show('term:conv:1', 'Terminal 1')
    await expect(viewers.show('term:conv:1', 'Terminal 1')).resolves.toBeUndefined()
    expect(children).toHaveLength(1)
    expect(log).toHaveBeenCalled()
  })

  it('keeps a viewer when activation fails with an error', async () => {
    const { viewers, children, log } = harness({
      activate: async () => {
        throw new Error('xdotool missing')
      },
    })
    await viewers.show('term:conv:1', 'Terminal 1')
    await expect(viewers.show('term:conv:1', 'Terminal 1')).resolves.toBeUndefined()
    expect(children).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('xdotool missing'))
  })

  it('reopens a viewer that was closed', async () => {
    const { viewers, children, activate } = harness()
    await viewers.show('term:conv:1', 'Terminal 1')
    children[0].exit(0)
    await settle()
    await viewers.show('term:conv:1', 'Terminal 1')
    expect(children).toHaveLength(2)
    expect(children[1].pid).not.toBe(children[0].pid)
    expect(activate).not.toHaveBeenCalled()
  })

  it('does not remove a newer viewer when an older process finally reports its exit', async () => {
    const { viewers, children } = harness()
    await viewers.show('term:conv:1', 'Terminal 1')
    viewers.close('term:conv:1')
    await viewers.show('term:conv:1', 'Terminal 1')
    await settle()
    await viewers.show('term:conv:1', 'Terminal 1')
    expect(children).toHaveLength(2)
  })

  it('limits the viewers of a bot to 8', async () => {
    const { viewers, children } = harness()
    for (let index = 1; index <= 8; index++) await viewers.show(`term:conv:${index}`, `Terminal ${index}`)
    await expect(viewers.show('term:conv:9', 'Terminal 9')).rejects.toThrow(/8/)
    expect(children).toHaveLength(8)
    // An existing viewer still comes forward at the limit.
    await viewers.show('term:conv:3', 'Terminal 3')
    expect(children).toHaveLength(8)
    // Closing one makes room.
    children[0].exit(0)
    await settle()
    await viewers.show('term:conv:9', 'Terminal 9')
    expect(children).toHaveLength(9)
  })

  it('takes the limit from the dependencies', async () => {
    const { viewers } = harness({ max: 1 })
    await viewers.show('term:conv:1', 'one')
    await expect(viewers.show('term:conv:2', 'two')).rejects.toThrow()
  })

  it('fails and keeps no viewer when xterm does not start', async () => {
    const { viewers, children } = harness({ pid: undefined })
    await expect(viewers.show('term:conv:1', 'Terminal 1')).rejects.toThrow(/xterm/)
    await expect(viewers.show('term:conv:1', 'Terminal 1')).rejects.toThrow(/xterm/)
    expect(children).toHaveLength(2)
  })

  it('fails when the spawn throws', async () => {
    const viewers = new TerminalViewers({
      env: ENV,
      spawn: () => {
        throw new Error('ENOENT')
      },
      activate: async () => true,
      log: vi.fn(),
    })
    await expect(viewers.show('term:conv:1', 'Terminal 1')).rejects.toThrow('ENOENT')
  })

  it('closes one viewer without touching the others', async () => {
    const { viewers, children } = harness()
    await viewers.show('term:conv:1', 'one')
    await viewers.show('term:conv:2', 'two')
    viewers.close('term:conv:1')
    viewers.close('term:conv:unknown')
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(children[1].kill).not.toHaveBeenCalled()
  })

  it('stops every viewer when disposed and refuses new ones', async () => {
    const { viewers, children } = harness()
    await viewers.show('term:conv:1', 'one')
    await viewers.show('term:conv:2', 'two')
    viewers.dispose()
    viewers.dispose()
    expect(children.map((child) => child.kill.mock.calls.length)).toEqual([1, 1])
    await expect(viewers.show('term:conv:3', 'three')).rejects.toThrow(/disposed/)
    expect(children).toHaveLength(2)
  })
})

describe('xdotoolActivate', () => {
  it('resolves false when xdotool is unavailable', async () => {
    const activate = xdotoolActivate({ PATH: '/nonexistent' }, 200)
    await expect(activate(12345)).resolves.toBe(false)
  })

  it('rejects a pid that is not a positive integer without running anything', async () => {
    const activate = xdotoolActivate({ PATH: '/nonexistent' }, 200)
    await expect(activate(-1)).resolves.toBe(false)
    await expect(activate(0)).resolves.toBe(false)
    await expect(activate(1.5)).resolves.toBe(false)
    await expect(activate(Number.NaN)).resolves.toBe(false)
  })

  describe.skipIf(process.platform === 'win32')('with a stand-in for xdotool', () => {
    function withFakeXdotool<T>(
      script: string,
      run: (env: Record<string, string>, calls: () => string[]) => Promise<T>
    ) {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'xdotool-'))
      const log = path.join(directory, 'calls')
      writeFileSync(
        path.join(directory, 'xdotool'),
        `#!/bin/sh\nprintf '%s|%s\\n' "$DISPLAY" "$*" >> '${log}'\n${script}\n`,
        {
          mode: 0o755,
        }
      )
      const env = { PATH: `${directory}${path.delimiter}${process.env.PATH}`, DISPLAY: ':7' }
      const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
      return run(env, calls).finally(() => rmSync(directory, { recursive: true, force: true }))
    }

    it('searches the window of the pid on the bot display and activates it', async () => {
      await withFakeXdotool('exit 0', async (env, calls) => {
        await expect(xdotoolActivate(env)(4242)).resolves.toBe(true)
        expect(calls()).toEqual([':7|search --pid 4242 --limit 1 windowactivate --sync'])
      })
    })

    it('resolves false when xdotool finds no window', async () => {
      await withFakeXdotool('exit 1', async (env) => {
        await expect(xdotoolActivate(env)(4242)).resolves.toBe(false)
      })
    })

    it('gives up on an xdotool that does not answer', async () => {
      await withFakeXdotool('exec sleep 5', async (env) => {
        const started = Date.now()
        await expect(xdotoolActivate(env, 100)(4242)).resolves.toBe(false)
        expect(Date.now() - started).toBeLessThan(3000)
      })
    })
  })
})
