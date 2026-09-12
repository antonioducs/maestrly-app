import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args.find((arg) => typeof arg === 'function') as ((error: Error | null) => void) | undefined
    cb?.(null)
  }),
}))

vi.mock('node:child_process', () => ({ execFile: h.execFile }))

import { playNativeSound } from '../../src/main/sound/native-player'

beforeEach(() => vi.clearAllMocks())

describe('playNativeSound', () => {
  it('macOS uses afplay and preserves attenuation', () => {
    playNativeSound('glass', 1, 'darwin')
    expect(h.execFile).toHaveBeenCalledWith('afplay', ['/System/Library/Sounds/Glass.aiff'], expect.any(Function))
    playNativeSound('submarine', 0.5, 'darwin')
    expect(h.execFile).toHaveBeenCalledWith(
      'afplay',
      ['-v', '0.5', '/System/Library/Sounds/Submarine.aiff'],
      expect.any(Function),
    )
  })

  it('Windows uses SystemSounds only at full volume and stays silent at partial volume to honor gain', () => {
    playNativeSound('glass', 0.3, 'win32')
    expect(h.execFile).not.toHaveBeenCalled()
    playNativeSound('glass', 1, 'win32')
    expect(h.execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-Command']),
      expect.any(Function),
    )
    expect((h.execFile.mock.calls[0]![1] as string[]).join(' ')).toContain('SystemSounds')
  })

  it('Linux uses paplay with volume and falls back to canberra on error', () => {
    h.execFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args.find((arg) => typeof arg === 'function') as (error: Error | null) => void
      cb(new Error('paplay failed'))
    })
    playNativeSound('glass', 1, 'linux')
    expect(h.execFile).toHaveBeenNthCalledWith(
      1,
      'paplay',
      ['/usr/share/sounds/freedesktop/stereo/complete.oga'],
      expect.any(Function),
    )
    expect(h.execFile).toHaveBeenNthCalledWith(
      2,
      'canberra-gtk-play',
      ['-i', 'complete'],
      expect.any(Function),
    )
  })

  it('Linux does not fall back to canberra at partial volume because it lacks gain support', () => {
    h.execFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args.find((arg) => typeof arg === 'function') as (error: Error | null) => void
      cb(new Error('paplay failed'))
    })
    playNativeSound('glass', 0.5, 'linux')
    expect(h.execFile).toHaveBeenCalledTimes(1)
  })

  it('ignores zero volume and invalid voices without throwing', () => {
    playNativeSound('glass', 0, 'darwin')
    // @ts-expect-error defensive payload
    playNativeSound('nope', 1, 'darwin')
    // @ts-expect-error an inherited property is not a voice
    playNativeSound('toString', 1, 'darwin')
    expect(h.execFile).not.toHaveBeenCalled()
  })

  it('contains synchronous player failures', () => {
    h.execFile.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    expect(() => playNativeSound('glass', 1, 'darwin')).not.toThrow()
  })
})
