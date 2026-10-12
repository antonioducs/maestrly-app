import { describe, expect, it } from 'vitest'
import { nextDefaultLabel, validLabel } from '../../src/renderer/components/chat/mcp-account-actions'

describe('MCP account labels', () => {
  it('suggests the lowest free default label', () => {
    expect(nextDefaultLabel([])).toBe('Account 1')
    expect(nextDefaultLabel(['Account 1', 'Account 3'])).toBe('Account 2')
    expect(nextDefaultLabel(['account 1'])).toBe('Account 2')
  })

  it('checks labels the way the host does', () => {
    expect(validLabel('work', ['Work'])).toBe('taken')
    expect(validLabel('', [])).toBe('invalid')
    expect(validLabel('   ', [])).toBe('invalid')
    expect(validLabel('x'.repeat(41), [])).toBe('invalid')
    expect(validLabel('bad/label', [])).toBe('invalid')
    expect(validLabel('joão@x.com', [])).toBe('ok')
    expect(validLabel(' Work ', ['Personal'])).toBe('ok')
  })
})
