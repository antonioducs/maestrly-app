import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  effectiveAutomation,columnAutomationSchema,
  apiErrorSchema,
  cardSchema,
  executionEnvelopeSchema,
  instanceMetadataSchema,
  supportsProtocol,
} from '../src/index.js'

const now = '2026-09-07T01:00:00.000Z'

describe('public protocol', () => {
  it('round-trips an authorized execution envelope', () => {
    const envelope = executionEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      organizationId: 'org', projectId: 'project', boardId: 'board', cardId: 'card', jobId: 'job', runId: 'run',
      attempt: 1, leaseId: 'lease', leaseExpiresAt: now, sourceEventId: 'event', cardVersion: 3, policyVersion: 2,
      executionProfileId: 'profile',
      snapshot: {
        title: 'Implement endpoint', description: 'Use the approved API contract', acceptanceCriteria: ['Tests pass'],
        taskType: 'code', provider: 'codex', model: 'gpt-5', repositoryBindingId: 'repo',
        delivery: { mode: 'patch', requireHumanApproval: true },
      },
    })
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope)
    expect(envelope.snapshot).not.toHaveProperty('token')
    expect(envelope.snapshot).not.toHaveProperty('workspacePath')
  })

  it('rejects local-offset dates and invalid card versions', () => {
    expect(() => cardSchema.parse({
      id: 'card', organizationId: 'org', projectId: 'project', boardId: 'board', columnId: 'column', parentCardId: null,
      title: 'Card', description: '', acceptanceCriteria: [], priority: 'medium', labels: [], assigneeUserIds: [],
      position: 0, version: 0, archivedAt: null, createdAt: '2026-09-06T22:00:00-03:00', updatedAt: now,
    })).toThrow()
  })

  it('accepts additive response fields while preserving required data', () => {
    const value = instanceMetadataSchema.parse({
      instanceId: 'instance', name: 'Local Maestrly', canonicalUrl: 'http://127.0.0.1:4310', apiVersion: 'v1',
      protocolVersions: [PROTOCOL_VERSION], authentication: { localAccounts: true, publicSignup: false, deviceAuthorization: true },
      futureCapability: true,
    })
    expect(value.instanceId).toBe('instance')
  })

  it('identifies protocol incompatibility through a stable error contract', () => {
    expect(supportsProtocol(PROTOCOL_VERSION)).toBe(true)
    expect(supportsProtocol('99.0')).toBe(false)
    expect(apiErrorSchema.parse({ code: 'PROTOCOL_INCOMPATIBLE', message: 'Upgrade required', requestId: 'req' }).code)
      .toBe('PROTOCOL_INCOMPATIBLE')
  })
})

 it('desktop automations run unattended while other approval policies remain explicit',()=>{
  const config=columnAutomationSchema.parse({provider:'maestrly',model:'desktop-model'})
  expect(effectiveAutomation(config,null).approvalRequired).toBe(false)
  const manual=columnAutomationSchema.parse({provider:'codex',model:'codex-model'})
  expect(effectiveAutomation(manual,null).approvalRequired).toBe(true)
  expect(effectiveAutomation(manual,{provider:'maestrly',model:'desktop-model'}).approvalRequired).toBe(false)
  expect(effectiveAutomation(manual,null).provider).toBe('codex')
 })
