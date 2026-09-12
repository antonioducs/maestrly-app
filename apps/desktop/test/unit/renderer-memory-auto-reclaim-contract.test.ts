import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const rendererSources = ['src/renderer/DesktopApp.tsx'] as const

describe('renderer automatic reclaim contract', () => {
  it.each(rendererSources)('%s gates both prune paths on the shared kill switch', (path) => {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

    expect(source).toContain('useMemoryAutoReclaim')
    expect(source.match(/if \(autoReclaimEnabled !== true\) return/g)).toHaveLength(2)
    expect(source.match(/^\s+autoReclaimEnabled,\s*$/gm)).toHaveLength(2)
    expect(source).toContain('setInterval')
  })
})
