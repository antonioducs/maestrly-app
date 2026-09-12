import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { CodexExecutor, type ExecutionContext } from '../src/index.js'

function context(): ExecutionContext {
  return {
    envelope: {
      protocolVersion: '1.0', organizationId: 'org', projectId: 'project', boardId: 'board', cardId: 'card', jobId: 'job', runId: 'run',
      attempt: 1, leaseId: 'lease', leaseExpiresAt: '2026-09-07T01:00:00.000Z', sourceEventId: 'event', cardVersion: 1,
      policyVersion: 1, executionProfileId: 'profile', snapshot: {
        title: 'Task', description: 'Description', acceptanceCriteria: [], taskType: 'code', provider: 'codex', model: 'gpt-5',
        repositoryBindingId: null, delivery: { mode: 'patch', requireHumanApproval: true },
      },
    },
    environment: { workspacePath: '/tmp/workspace', isolated: true, environment: { OPENAI_API_KEY: 'test' }, cleanup: async () => undefined },
    emit: vi.fn(async () => undefined),
  }
}

describe('CodexExecutor', () => {
  it('maps deterministic JSONL completion and does not substitute model or sandbox', async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; kill: () => boolean }
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123; child.kill = () => true
    const spawnProcess = vi.fn(() => child) as never
    const executor = new CodexExecutor({ spawnProcess,catalogLoader:async()=>[{slug:'gpt-5',multi_agent_version:'v2'}] })
    const input=context()
    input.envelope.snapshot.effort='high'
    input.envelope.snapshot.fastMode=true
    input.envelope.snapshot.fastServiceTier='priority'
    const handle = await executor.start(input)
    child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Implemented and tested.' } })}\n`)
    child.emit('close', 0, null)
    await expect(handle.done).resolves.toMatchObject({ state: 'succeeded', summary: 'Implemented and tested.' })
    expect(spawnProcess).toHaveBeenCalledWith('codex', expect.arrayContaining(['--model', 'gpt-5', '--sandbox', 'workspace-write','model_reasoning_effort="high"','service_tier="priority"']), expect.objectContaining({ shell: false }))
  })

  it('reports truncated or malformed output as a failed incomplete run', async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; kill: () => boolean }
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 124; child.kill = () => true
    const executor = new CodexExecutor({ spawnProcess: vi.fn(() => child) as never,catalogLoader:async()=>[{slug:'gpt-5',multi_agent_version:'v2'}] })
    const handle = await executor.start(context())
    child.stdout.write('{not-json}\n')
    child.emit('close', 1, null)
    await expect(handle.done).resolves.toMatchObject({ state: 'failed' })
  })
})
