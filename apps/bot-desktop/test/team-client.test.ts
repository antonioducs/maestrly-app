import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { BotJournal } from '../src/main/bot-journal'
import { TeamClient, validateTeamCall } from '../src/main/team-client'
import { HostRequestError } from '../src/main/host-client'

const hostId = 'd9a02e5b-0c12-4411-9393-b5106ecff181'
const otherHost = '11111111-2222-3333-4444-555555555555'
const stamp = new Date().toISOString()
const team = {
  id: 'team-1',
  hostId,
  name: 'Relatórios',
  objective: '',
  coordinatorBotId: 'bot-1',
  conversationId: 'conv-1',
  status: 'active' as const,
  policy: { concurrency: 2, maxRounds: 3, maxTasks: 12, maxTurns: 24, maxToolCalls: 300, maxActiveMs: 3_600_000, permissionMode: 'ask' as const, shareMemory: true, shareArtifacts: true },
  revision: 0,
  createdAt: stamp,
  updatedAt: stamp,
}
const run = {
  id: 'run-1',
  teamId: team.id,
  conversationId: team.conversationId,
  messageId: 'msg-1',
  coordinatorBotId: 'bot-1',
  roster: [{ memberId: 'm1', botId: 'bot-1', name: 'Ana', role: '', coordinator: true }],
  resources: [],
  memberGrantRevision: 1,
  limits: team.policy,
  budget: { rounds: 0, tasks: 0, turns: 0, toolCallsReserved: 0, toolCallsSettled: 0, activeMsReserved: 0, activeMsSettled: 0, consolidationHeld: true, tokensObserved: false },
  round: 0,
  status: 'planning' as const,
  generation: 1,
  revision: 0,
  createdAt: stamp,
  updatedAt: stamp,
}
const message = {
  id: 'msg-1',
  conversationId: team.conversationId,
  clientMessageId: 'c1',
  author: { kind: 'human' as const },
  kind: 'request' as const,
  content: 'faça o relatório',
  runId: run.id,
  sequence: 1,
  artifacts: [],
  createdAt: stamp,
}
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'team-journal-'))
  return { dir, file: join(dir, 'journal.json') }
}

it('journals the team key before sending and records a receipt that points at the run', async () => {
  const { dir, file } = await directory()
  try {
    const sends: string[] = []
    const client = new TeamClient(new BotJournal(file), async (method, params) => {
      if (method === 'team.messages.send') {
        sends.push(String(params.clientMessageId))
        // The durable key exists on disk before the wire write, in the team namespace.
        const entries = JSON.parse(await readFile(file, 'utf8'))
        expect(entries[0].key).toBe(`team:${team.id}:c1`)
        expect(entries[0].method).toBe('team.messages.send')
        expect(entries[0].receipt).toBeUndefined()
        return { message, run }
      }
      throw new Error(`unexpected ${method}`)
    })
    client.connected(hostId)
    const receipt = await client.call({ method: 'team.messages.send', params: { teamId: team.id, clientMessageId: 'c1', content: 'faça o relatório', artifactIds: [] } })
    expect((receipt as { run: { id: string } }).run.id).toBe(run.id)
    const entries = JSON.parse(await readFile(file, 'utf8'))
    // The receipt references the run, not a bot turn or a VM operation.
    expect(entries[0].receipt).toEqual({ id: run.id, kind: 'turn' })
    expect(sends).toEqual(['c1'])
    // Content and attachments are never journaled: only identity.
    expect(JSON.stringify(entries)).not.toContain('faça o relatório')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('resolves a lost reply by looking the key up, never by sending again', async () => {
  const { dir, file } = await directory()
  try {
    const sends: string[] = []
    let lose = true
    const lookups: string[] = []
    const request = async (method: string, params: Record<string, unknown>) => {
      if (method === 'team.messages.send') {
        sends.push(String(params.clientMessageId))
        if (lose) {
          lose = false
          throw new Error('SSH disconnected')
        }
        return { message, run }
      }
      if (method === 'team.messages.lookup') {
        lookups.push(String(params.clientMessageId))
        return { message, run }
      }
      throw new Error(`unexpected ${method}`)
    }
    const client = new TeamClient(new BotJournal(file), request)
    client.connected(hostId)
    await expect(client.call({ method: 'team.messages.send', params: { teamId: team.id, clientMessageId: 'c1', content: 'x', artifactIds: [] } })).rejects.toThrow()
    const recovered = await client.recover()
    expect(recovered).toEqual({ recovered: 1, unresolved: 0 })
    // The request was written once; recovery asked, it did not repeat.
    expect(sends).toEqual(['c1'])
    expect(lookups).toEqual(['c1'])
    expect(JSON.parse(await readFile(file, 'utf8'))[0].receipt).toEqual({ id: run.id, kind: 'turn' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps the draft when the Host never accepted the request', async () => {
  const { dir, file } = await directory()
  try {
    const client = new TeamClient(new BotJournal(file), async (method) => {
      if (method === 'team.messages.send') throw new Error('connection lost')
      if (method === 'team.messages.lookup') return null
      throw new Error(`unexpected ${method}`)
    })
    client.connected(hostId)
    await expect(client.call({ method: 'team.messages.send', params: { teamId: team.id, clientMessageId: 'c1', content: 'x', artifactIds: [] } })).rejects.toThrow()
    const recovered = await client.recover()
    // Never accepted: the key is dropped so the person keeps the draft and decides.
    expect(recovered).toEqual({ recovered: 0, unresolved: 0 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('uses the team namespace for operations and never the bot lookups', async () => {
  const { dir, file } = await directory()
  try {
    const asked: string[] = []
    let lose = true
    const operation = { id: 'op-1', kind: 'team.artifact.share' as const, teamId: team.id, status: 'succeeded' as const, createdAt: stamp, updatedAt: stamp }
    const client = new TeamClient(new BotJournal(file), async (method) => {
      asked.push(method)
      if (method === 'team.artifacts.share') {
        if (lose) {
          lose = false
          throw new Error('connection lost')
        }
        return operation
      }
      if (method === 'team.operation.lookup') return operation
      throw new Error(`unexpected ${method}`)
    })
    client.connected(hostId)
    await expect(
      client.call({ method: 'team.artifacts.share', params: { teamId: team.id, idempotencyKey: 'key-1', botId: 'bot-1', path: 'dados.csv' } })
    ).rejects.toThrow()
    await client.recover()
    expect(asked).toEqual(['team.artifacts.share', 'team.operation.lookup'])
    expect(asked).not.toContain('bot.operation.lookup')
    expect(JSON.parse(await readFile(file, 'utf8'))[0].receipt).toEqual({ id: 'op-1', kind: 'operation' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('never replays a mutation against a different Host that shares the journal', async () => {
  const { dir, file } = await directory()
  try {
    const lookups: string[] = []
    const client = new TeamClient(new BotJournal(file), async (method) => {
      if (method === 'team.messages.send') throw new Error('connection lost')
      lookups.push(method)
      return { message, run }
    })
    client.connected(hostId)
    await expect(client.call({ method: 'team.messages.send', params: { teamId: team.id, clientMessageId: 'c1', content: 'x', artifactIds: [] } })).rejects.toThrow()
    // A different Host must not resolve — or replay — the first Host's pending key.
    client.connected(otherHost)
    expect(await client.unresolved()).toEqual([])
    expect(await client.recover()).toEqual({ recovered: 0, unresolved: 0 })
    expect(lookups).toEqual([])
    client.connected(hostId)
    expect((await client.unresolved()).map((entry) => entry.key)).toEqual([`team:${team.id}:c1`])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('drops the key on a definitive refusal instead of retrying it forever', async () => {
  const { dir, file } = await directory()
  try {
    const client = new TeamClient(new BotJournal(file), async () => {
      throw new HostRequestError('A equipe ainda está trabalhando', 'TEAM_RUN_ACTIVE')
    })
    client.connected(hostId)
    await expect(client.call({ method: 'team.messages.send', params: { teamId: team.id, clientMessageId: 'c1', content: 'x', artifactIds: [] } })).rejects.toMatchObject({
      code: 'TEAM_RUN_ACTIVE',
    })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('refuses anything outside the team namespace before it reaches the wire', async () => {
  const { dir, file } = await directory()
  try {
    let calls = 0
    const client = new TeamClient(new BotJournal(file), async () => {
      calls++
      return {}
    })
    client.connected(hostId)
    for (const call of [
      { method: 'vm.shutdown', params: { vmId: 'v', expectedRevision: 0, idempotencyKey: 'k' } },
      { method: 'bot.archive', params: { botId: 'b', expectedRevision: 0, idempotencyKey: 'k' } },
      { method: 'team.unknown', params: {} },
      { method: 'team.messages.send', params: { teamId: team.id, clientMessageId: 'c', content: 'x', extra: true } },
      { method: 'team.create', params: { idempotencyKey: 'k', name: 'T', members: [{ botId: 'a' }] } },
    ])
      await expect(client.call(call), call.method).rejects.toThrow()
    expect(calls).toBe(0)
    expect(() => validateTeamCall({ method: 'team.list', params: {}, extra: 1 })).toThrow()
    expect(validateTeamCall({ method: 'team.list', params: {} }).params).toEqual({ includeArchived: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('refuses to call a team method before a Host is connected', async () => {
  const { dir, file } = await directory()
  try {
    const client = new TeamClient(new BotJournal(file), async () => ({}))
    await expect(client.call({ method: 'team.list', params: {} })).rejects.toThrow(/Conecte-se/)
    expect(randomUUID()).toBeTruthy()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
