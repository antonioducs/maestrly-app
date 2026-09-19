import { describe, expect, it } from 'vitest'
import {
  CURSOR_SDK_PLATFORM_INTEGRITY,
  CURSOR_SDK_SIZE_NOTES,
  CURSOR_SDK_VERSION,
  isCursorSdkPlatformSupported,
  listCursorSdkPlatformTargets,
  resolveCursorSdkPlatformTarget,
} from '../../src/main/chat/cursor-sdk/platform'

describe('Cursor SDK platform targets', () => {
  it('pins the SDK version', () => {
    expect(CURSOR_SDK_VERSION).toBe('1.0.31')
  })

  it('lists five supported targets and marks win-arm64 unsupported', () => {
    const targets = listCursorSdkPlatformTargets()
    expect(targets.filter((t) => t.supported)).toHaveLength(5)
    const winArm = targets.find((t) => t.platform === 'win32' && t.arch === 'arm64')
    expect(winArm?.supported).toBe(false)
    expect(winArm?.notes).toMatch(/does not exist/i)
  })

  it('resolves known and unknown platforms', () => {
    expect(resolveCursorSdkPlatformTarget('darwin', 'arm64')).toMatchObject({
      npmPackage: '@cursor/sdk-darwin-arm64',
      materializedId: 'mac-arm64',
      supported: true,
    })
    expect(resolveCursorSdkPlatformTarget('win32', 'arm64').supported).toBe(false)
    expect(resolveCursorSdkPlatformTarget('freebsd' as NodeJS.Platform, 'x64').supported).toBe(false)
  })

  it('reports host support via isCursorSdkPlatformSupported', () => {
    // This machine is macOS arm64 in CI/dev for Maestrly — still assert API shape.
    expect(typeof isCursorSdkPlatformSupported()).toBe('boolean')
    expect(isCursorSdkPlatformSupported('linux', 'x64')).toBe(true)
    expect(isCursorSdkPlatformSupported('win32', 'arm64')).toBe(false)
  })

  it('has integrity hashes for every supported materialized id', () => {
    for (const target of listCursorSdkPlatformTargets().filter((t) => t.supported)) {
      expect(CURSOR_SDK_PLATFORM_INTEGRITY[target.materializedId]).toMatch(/^sha512-/)
    }
    expect(CURSOR_SDK_SIZE_NOTES.engines).toMatch(/22\.13/)
  })
})
