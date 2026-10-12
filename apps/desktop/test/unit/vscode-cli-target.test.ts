import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/test-user-data' } }))

import { cliTarget } from '../../src/main/vscode/vscode-cli-download'

describe('VS Code CLI download target', () => {
  it('names the builds Microsoft publishes for each system', () => {
    expect(cliTarget('darwin', 'arm64')).toBe('cli-darwin-arm64')
    expect(cliTarget('darwin', 'x64')).toBe('cli-darwin-x64')
    expect(cliTarget('win32', 'x64')).toBe('cli-win32-x64')
    expect(cliTarget('win32', 'arm64')).toBe('cli-win32-arm64')
    expect(cliTarget('linux', 'arm')).toBe('cli-linux-armhf')
  })

  it('takes the static Alpine CLI on x64 and arm64 Linux, where no glibc build is published', () => {
    expect(cliTarget('linux', 'x64')).toBe('cli-alpine-x64')
    expect(cliTarget('linux', 'arm64')).toBe('cli-alpine-arm64')
  })
})
