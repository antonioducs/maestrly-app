import { describe, expect, it } from 'vitest'
import { listDisplayWindows, type RunText } from '../../src/main/remote-host/server/computer-windows'

function fake(replies: Record<string, string | Error>): { run: RunText; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args])
      const reply = replies[args.join(' ')]
      if (reply instanceof Error) throw reply
      if (reply === undefined) throw new Error('unexpected ' + args.join(' '))
      return reply
    },
  }
}

describe('listDisplayWindows', () => {
  it("reads the windows' process ids, null when a window reports none", async () => {
    const { run, calls } = fake({
      '-display :10 -root _NET_CLIENT_LIST': '_NET_CLIENT_LIST(WINDOW): window id # 0x400001, 0x600003\n',
      '-display :10 -id 0x400001 _NET_WM_PID': '_NET_WM_PID(CARDINAL) = 812\n',
      '-display :10 -id 0x600003 _NET_WM_PID': '_NET_WM_PID:  not found.\n',
    })
    expect(await listDisplayWindows(':10', run)).toEqual([{ pid: 812 }, { pid: null }])
    expect(calls.every(([command]) => command === 'xprop')).toBe(true)
  })

  it('has no windows when the window manager lists none', async () => {
    const { run } = fake({ '-display :10 -root _NET_CLIENT_LIST': '_NET_CLIENT_LIST:  not found.\n' })
    expect(await listDisplayWindows(':10', run)).toEqual([])
  })

  it('answers one window of unknown origin when xprop fails', async () => {
    const { run } = fake({ '-display :10 -root _NET_CLIENT_LIST': new Error('unable to open display') })
    expect(await listDisplayWindows(':10', run)).toEqual([{ pid: null }])
  })
})
