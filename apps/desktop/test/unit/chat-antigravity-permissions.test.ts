import { describe, expect, it } from 'vitest'
import type { AcpPermissionOption, AcpPermissionRequest } from '../../src/main/chat/acp/protocol'
import {
  createAntigravityImagePermissionPolicy,
  decideAntigravityPermission,
} from '../../src/main/chat/antigravity-subscription/permissions'

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

describe('Antigravity image session permission policy', () => {
  const imageCall = (title = 'Run generate_image?', meta?: AcpPermissionRequest['toolCall']['_meta']) => ({
    sessionId: 's',
    toolCall: { toolCallId: 't', title, kind: 'other', _meta: meta },
    options: ALL_OPTIONS,
  })

  it('allows the first generate_image call once, never always', () => {
    const decide = createAntigravityImagePermissionPolicy()
    expect(decide(imageCall())).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(decide(imageCall())).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
  })

  it('keeps rejecting other built-in tools', () => {
    const decide = createAntigravityImagePermissionPolicy()
    expect(decide(imageCall('Run run_command?'))).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    // An MCP call named like the tool is not the built-in.
    expect(decide(imageCall('maestrly_generate_image', { mcp: { server: 'other', tool: 'generate_image' } }))).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    })
    expect(decide(imageCall())).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  })
})
