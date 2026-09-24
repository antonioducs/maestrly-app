import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getGatewayVersion } from '../src/host.js'
import { run } from '../src/main.js'

const packageVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version

describe('gateway version', () => {
  it('uses the image build version and falls back to the package version', () => {
    expect(getGatewayVersion({ MAESTRLY_GATEWAY_VERSION: ' 0.9.2 ' })).toBe('0.9.2')
    expect(getGatewayVersion({})).toBe(packageVersion)
  })

  it('prints the same version from the CLI', async () => {
    const lines: string[] = []
    expect(
      await run(['--version'], (line) => lines.push(line), {
        MAESTRLY_GATEWAY_VERSION: '0.9.2',
      })
    ).toBe(0)
    expect(lines).toEqual(['0.9.2 (protocol 1)'])
  })
})
