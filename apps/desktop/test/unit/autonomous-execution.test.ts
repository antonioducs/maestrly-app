import {tool,type ToolSet} from 'ai'
import {z} from 'zod'
import { describe, it, expect } from 'vitest'
import {
  registerAutonomousConversation,
  withAutonomousPolicy,
  autonomousPolicy,
  autonomousProviderAllowed,governAutonomousTools,
  assertAutonomousPermission,
  AutonomousInteractionError,
} from '../../src/main/chat/autonomous'
import { QuestionBroker } from '../../src/main/chat/question-broker'
import { PermissionBroker } from '../../src/main/chat/permission'
import { stagePlan, getPending } from '../../src/main/plan-broker'
const policy = {
  cwd: '/project',
  allowCommands: true,
  allowWeb: true,
  allowAppTools: true,
  allowMcp: false,
  allowPush: false,
}
describe('unattended execution boundaries', () => {
  it('never leaves questions or plans pending, and keeps manual conversations independent', async () => {
    const release = registerAutonomousConversation('job', policy)
    try {
      const broker = new QuestionBroker()
      await expect(
        broker.ask({ conversationId: 'job', messageId: 'm', toolCallId: 'q', questions: [] })
      ).rejects.toBeInstanceOf(AutonomousInteractionError)
      expect(broker.pendingFor('job')).toEqual([])
      expect(() => stagePlan({ agentId: 'job', cwd: '/project', plan: 'Do this' })).toThrow(/No human/)
      expect(getPending('job')).toBeNull()
      expect(autonomousPolicy('manual')).toBeUndefined()
      const answer = broker.ask({ conversationId: 'manual', messageId: 'm', toolCallId: 'normal', questions: [] })
      expect(broker.pendingFor('manual')).toEqual(['normal'])
      broker.reply('normal', [['yes']])
      expect(await answer).toEqual([['yes']])
    } finally {
      release()
    }
  })
  it('uses only explicit permissions without waiting for an operator', async () => {
    const release = registerAutonomousConversation('job', policy)
    try {
      const broker = new PermissionBroker({ rulesetFor: () => [{ action: '*', resource: '*', effect: 'ask' }] })
      await expect(
        broker.assert({ conversationId: 'job', projectId: 'p', action: 'edit', resources: ['src/app.ts'] })
      ).resolves.toBeUndefined()
      await expect(
        broker.assert({ conversationId: 'job', projectId: 'p', action: 'mcp', resources: ['unknown_remote_tool'] })
      ).rejects.toThrow(/not preauthorized/)
      await expect(
        broker.assert({ conversationId: 'job', projectId: 'p', action: 'external_directory', resources: ['/private'] })
      ).rejects.toThrow(/not preauthorized/)
      expect(broker.pendingFor('job')).toEqual([])
      expect(() => assertAutonomousPermission(policy, { action: 'bash', resources: ['git push origin main'] })).toThrow(
        /git push/
      )
      expect(() => assertAutonomousPermission(policy, { action: 'read', resources: ['../secret'] })).toThrow(/outside/)
      expect(() => assertAutonomousPermission(policy, { action: 'read', resources: ['.env'] })).toThrow(/secrets/)
    } finally {
      release()
    }
  })
  it('captures unattended policy for SDK callbacks and delegation outside the admission async context', async()=>{
    const scoped={...policy,providerIds:['allowed']}
    const release=registerAutonomousConversation('job',scoped)
    try {
      const tools:ToolSet={task:tool({inputSchema:z.object({}),execute:async()=>{await Promise.resolve();return {policy:autonomousPolicy('child'),allowed:autonomousProviderAllowed('allowed'),other:autonomousProviderAllowed('private')}}}),ask_question:tool({inputSchema:z.object({}),execute:async()=> 'must not run'})}
      governAutonomousTools(tools,'job')
      expect(tools.ask_question).toBeUndefined()
      expect(autonomousPolicy('child')).toBeUndefined()
      expect(await tools.task!.execute!({}, {toolCallId:'task',messages:[],context:{}})).toEqual({policy:scoped,allowed:true,other:false})
      expect(autonomousPolicy('manual')).toBeUndefined()
    } finally {release()}
  })
  it('inherits unattended policy across asynchronous delegated work', async () => {
    await withAutonomousPolicy(policy, async () => {
      await Promise.resolve()
      expect(autonomousPolicy('delegate')).toBe(policy)
    })
    expect(autonomousPolicy('manual')).toBeUndefined()
  })
})
