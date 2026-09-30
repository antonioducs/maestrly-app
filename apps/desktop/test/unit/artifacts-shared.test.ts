import { describe, expect, it } from 'vitest'
import { parseArtifactToolResult } from '../../src/shared/artifacts'

const id = 'A'.repeat(22)
const result = (artifact: unknown, ok: unknown = true) => JSON.stringify({ ok, artifact, skipped: [], note: 'x' })

describe('parseArtifactToolResult', () => {
  it('reads the artifact of a create or update result', () => {
    expect(parseArtifactToolResult(result({ id, title: 'T', version: 2 }))).toEqual({ id, title: 'T', version: 2 })
    expect(parseArtifactToolResult(result({ id, title: 'Updated', version: 7 }))).toEqual({
      id,
      title: 'Updated',
      version: 7,
    })
  })

  it('rejects failures and malformed results', () => {
    expect(parseArtifactToolResult(result({ id, title: 'T', version: 2 }, false))).toBeNull()
    expect(parseArtifactToolResult('not json')).toBeNull()
    expect(parseArtifactToolResult('null')).toBeNull()
    expect(parseArtifactToolResult(result({ id: '../x', title: 'T', version: 2 }))).toBeNull()
    expect(parseArtifactToolResult(result({ id, title: 'T', version: 0 }))).toBeNull()
    expect(parseArtifactToolResult(result({ id, title: 3, version: 1 }))).toBeNull()
  })
})
