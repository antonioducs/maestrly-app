import { describe, expect, it } from 'vitest'
import type { AcpPermissionOption, AcpPermissionRequest } from '../../src/main/chat/acp/protocol'
import { decideAntigravityPermission } from '../../src/main/chat/antigravity-subscription/permissions'

const ALL_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow_always', name: 'Allow Always', kind: 'allow_always' },
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
]

function request(meta: AcpPermissionRequest['toolCall']['_meta'], options = ALL_OPTIONS): AcpPermissionRequest {
  return { sessionId: 's', toolCall: { toolCallId: 't', title: 'x', _meta: meta }, options }
}

describe('Antigravity permission policy', () => {
  it('allows Maestrly host MCP tools once, never always', () => {
    expect(decideAntigravityPermission(request({ mcp: { server: 'maestrly', tool: 'read_file' } }))).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
  })

  it('rejects native Antigravity tools and other MCP servers', () => {
    expect(decideAntigravityPermission(request(undefined))).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    })
    expect(decideAntigravityPermission(request({ mcp: { server: 'other', tool: 'x' } }))).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    })
  })

  it('falls back to reject_always, then cancels', () => {
    const rejectAlways: AcpPermissionOption[] = [{ optionId: 'never', name: 'Never', kind: 'reject_always' }]
    expect(decideAntigravityPermission(request(undefined, rejectAlways))).toEqual({
      outcome: { outcome: 'selected', optionId: 'never' },
    })
    expect(decideAntigravityPermission(request(undefined, []))).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('cancels a Maestrly tool offered only as allow_always', () => {
    const options: AcpPermissionOption[] = [
      { optionId: 'allow_always', name: 'Allow Always', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ]
    expect(decideAntigravityPermission(request({ mcp: { server: 'maestrly' } }, options))).toEqual({
      outcome: { outcome: 'cancelled' },
    })
  })

  it('treats malformed requests as rejected', () => {
    expect(decideAntigravityPermission(null)).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})
