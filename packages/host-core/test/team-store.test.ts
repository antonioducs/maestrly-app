import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HostStore } from '../src/persistence/store.js'
import { HOST_DB_VERSION } from '../src/bots/migrations.js'
import { migrateToV6 } from '../src/teams/migrations.js'
import { BotRepository } from '../src/bots/repository.js'
import { TeamRepository } from '../src/teams/repository.js'
import { directory } from './bot-helpers.js'

const skipWindows = process.platform === 'win32'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const stamp = new Date().toISOString()
const botBase = {
  purpose: '',
  instructions: '',
  status: 'ready' as const,
  runtimeState: 'ready' as const,
  accountState: 'connected' as const,
  permissionMode: 'ask' as const,
  revision: 0,
  createdAt: stamp,
  updatedAt: stamp,
}
async function openStore() {
  const dir = await directory()
  dirs.push(dir)
  return new HostStore(dir)
}
/** Two ready bots, each with its own conversation, as the teams domain always finds them. */
function seedBots(repo: BotRepository, ids: string[], vmId?: string) {
  for (const id of ids) {
    repo.saveBot({ id, name: id.toUpperCase(), vmId, conversationId: `conv-${id}`, ...botBase })
    repo.saveConversation({ id: `conv-${id}`, botId: id, title: '', contextRevision: 0, lastSequence: 0, revision: 0, createdAt: stamp, updatedAt: stamp })
  }
}
function seedTeam(teams: TeamRepository, hostId: string, botIds: string[]) {
  // The team row comes first: its conversation is a child of the team, never the reverse.
  teams.saveTeam({
    id: 'team-1',
    hostId,
    name: 'Relatórios',
    objective: '',
    coordinatorBotId: botIds[0],
    conversationId: 'team-conv',
    status: 'active',
    policy: {
      concurrency: 2,
      maxRounds: 3,
      maxTasks: 12,
      maxTurns: 24,
      maxToolCalls: 300,
      maxActiveMs: 3_600_000,
      permissionMode: 'ask',
      shareMemory: true,
      shareArtifacts: true,
    },
    revision: 0,
    createdAt: stamp,
    updatedAt: stamp,
  })
  teams.saveConversation({ id: 'team-conv', teamId: 'team-1', title: '', lastSequence: 0, revision: 0, createdAt: stamp, updatedAt: stamp })
  botIds.forEach((botId, index) =>
    teams.saveMember({
      id: `member-${botId}`,
      teamId: 'team-1',
      botId,
      role: index === 0 ? 'coordenador' : 'analista',
      coordinator: index === 0,
      active: true,
      consentedAt: stamp,
      grantRevision: 1,
      createdAt: stamp,
      updatedAt: stamp,
    })
  )
}
const runBase = {
  teamId: 'team-1',
  conversationId: 'team-conv',
  messageId: 'msg-1',
  coordinatorBotId: 'a',
  roster: [{ memberId: 'member-a', botId: 'a', name: 'A', role: '', coordinator: true }],
  resources: [],
  memberGrantRevision: 1,
  limits: {
    concurrency: 2,
    maxRounds: 3,
    maxTasks: 12,
    maxTurns: 24,
    maxToolCalls: 300,
    maxActiveMs: 3_600_000,
    permissionMode: 'ask' as const,
    shareMemory: true,
    shareArtifacts: true,
  },
  budget: {
    rounds: 0,
    tasks: 0,
    turns: 0,
    toolCallsReserved: 0,
    toolCallsSettled: 0,
    activeMsReserved: 0,
    activeMsSettled: 0,
    consolidationHeld: true,
    tokensObserved: false,
  },
  round: 0,
  generation: 1,
  revision: 0,
  createdAt: stamp,
  updatedAt: stamp,
}
const taskBase = {
  runId: 'run-1',
  teamId: 'team-1',
  round: 1,
  kind: 'work' as const,
  memberId: 'member-b',
  goal: 'analisar',
  acceptanceCriteria: '',
  dependsOn: [],
  inputArtifactIds: [],
  useDependencyOutputs: true,
  origin: 'coordinator' as const,
  attempts: 0,
  revision: 0,
  createdAt: stamp,
  updatedAt: stamp,
}

describe.skipIf(skipWindows)('team schema migration and durable store', () => {
  it('migrates 5→6 without rewriting bots, sessions, accounts or desktop state', async () => {
    const store = await openStore()
    try {
      const bots = new BotRepository(store)
      seedBots(bots, ['a'], 'vm-1')
      const before = bots.bot('a')
      const conversation = bots.conversation('conv-a')
      expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(HOST_DB_VERSION)
      expect(HOST_DB_VERSION).toBe(6)
      // Re-running the migration on an already migrated database is a no-op.
      migrateToV6(store.db)
      expect(bots.bot('a')).toEqual(before)
      expect(bots.conversation('conv-a')).toEqual(conversation)
      expect(new TeamRepository(store).teams()).toEqual([])
    } finally {
      store.close()
    }
  })

  it('rolls back a failed 5→6 migration and refuses a future schema', async () => {
    const dir = await directory()
    dirs.push(dir)
    const path = join(dir, 'host.sqlite')
    const created = new HostStore(dir)
    created.close()
    const db = new DatabaseSync(path)
    // Rewind to schema 5 (children first) and leave one conflicting table behind.
    db.exec(
      `DROP TABLE team_artifact_grants; DROP TABLE team_artifacts; DROP TABLE team_transfers; DROP TABLE team_memory;
       DROP TABLE team_requests; DROP TABLE team_events; DROP TABLE team_task_turns; DROP TABLE team_task_dependencies;
       DROP TABLE team_tasks; DROP TABLE team_runs; DROP TABLE team_messages; DROP TABLE team_conversations;
       DROP TABLE team_members; DROP TABLE teams; DROP TABLE team_operations;
       CREATE TABLE team_runs(x TEXT); PRAGMA user_version=5;`
    )
    expect(() => migrateToV6(db)).toThrow()
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='teams'").get()).toBeUndefined()
    db.exec('PRAGMA user_version=99')
    db.close()
    expect(() => new HostStore(dir)).toThrow('Unsupported host database version')
  })

  it('keeps one active run per team conversation and one attempt per physical turn', async () => {
    const store = await openStore()
    try {
      const bots = new BotRepository(store)
      const teams = new TeamRepository(store)
      seedBots(bots, ['a', 'b'])
      seedTeam(teams, store.hostId, ['a', 'b'])
      teams.saveRun({ id: 'run-1', ...runBase, status: 'planning' })
      expect(() => teams.saveRun({ id: 'run-2', ...runBase, status: 'queued' })).toThrowError(expect.objectContaining({ code: 'TEAM_RUN_ACTIVE' }))
      teams.saveRun({ id: 'run-1', ...runBase, status: 'succeeded' })
      teams.saveRun({ id: 'run-2', ...runBase, status: 'queued' })
      expect(teams.activeRun('team-conv')?.id).toBe('run-2')

      teams.saveRun({ id: 'run-2', ...runBase, status: 'succeeded' })
      teams.saveRun({ id: 'run-1', ...runBase, status: 'working' })
      teams.saveTask({ id: 'task-1', localKey: 'analise', assigneeBotId: 'b', status: 'running', ...taskBase })
      // The same round cannot hold two tasks under the same coordinator-chosen key.
      expect(() => teams.saveTask({ id: 'task-2', localKey: 'analise', assigneeBotId: 'b', status: 'planned', ...taskBase })).toThrow(/UNIQUE/)
      teams.saveTask({ id: 'task-2', localKey: 'texto', assigneeBotId: 'b', status: 'planned', ...taskBase })

      bots.saveTurn({ id: 'turn-1', botId: 'b', conversationId: 'conv-b', messageId: 'm1', status: 'running', generation: 1, revision: 0, createdAt: stamp, updatedAt: stamp })
      const attempt = {
        taskId: 'task-1',
        runId: 'run-1',
        botId: 'b',
        turnId: 'turn-1',
        conversationId: 'conv-b',
        generation: 1,
        reservedToolCalls: 40,
        reservedActiveMs: 600_000,
        settled: false,
        createdAt: stamp,
        updatedAt: stamp,
      }
      teams.saveAttempt({ id: 'attempt-1', ...attempt })
      // One physical turn belongs to exactly one logical task.
      expect(() => teams.saveAttempt({ id: 'attempt-2', ...attempt, taskId: 'task-2' })).toThrowError(expect.objectContaining({ code: 'TEAM_BUSY' }))
      expect(teams.attemptByTurn('turn-1')?.taskId).toBe('task-1')
      expect(teams.activeTasksOfBot('b').map((t) => t.id)).toEqual(['task-1'])
    } finally {
      store.close()
    }
  })

  it('refuses repeated membership and links only bots that exist on this Host', async () => {
    const store = await openStore()
    try {
      const bots = new BotRepository(store)
      const teams = new TeamRepository(store)
      seedBots(bots, ['a', 'b'])
      seedTeam(teams, store.hostId, ['a', 'b'])
      expect(() =>
        teams.saveMember({
          id: 'member-dup',
          teamId: 'team-1',
          botId: 'b',
          role: '',
          coordinator: false,
          active: true,
          consentedAt: stamp,
          grantRevision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        })
      ).toThrowError(expect.objectContaining({ code: 'TEAM_MEMBER_INVALID' }))
      expect(() =>
        teams.saveMember({
          id: 'member-foreign',
          teamId: 'team-1',
          botId: 'bot-of-another-host',
          role: '',
          coordinator: false,
          active: true,
          consentedAt: stamp,
          grantRevision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        })
      ).toThrow(/FOREIGN KEY/)
      expect(teams.members('team-1').map((m) => m.botId)).toEqual(['a', 'b'])
      expect(teams.teamsOfBot('b').map((t) => t.id)).toEqual(['team-1'])
    } finally {
      store.close()
    }
  })

  it('replays a collaboration receipt instead of acting twice and flags a different payload', async () => {
    const store = await openStore()
    try {
      const teams = new TeamRepository(store)
      teams.saveReceipt({ turnId: 'turn-1', requestId: 'req-1', method: 'team_delegate', fingerprint: 'f1', response: { receiptId: 'r1' }, createdAt: stamp })
      expect(teams.receipt('turn-1', 'req-1')?.response).toEqual({ receiptId: 'r1' })
      expect(teams.receipt('turn-1', 'req-2')).toBeUndefined()
      expect(() => teams.saveReceipt({ turnId: 'turn-1', requestId: 'req-1', method: 'team_delegate', fingerprint: 'f2', response: {}, createdAt: stamp })).toThrow(/UNIQUE/)
      const stored = teams.receipt('turn-1', 'req-1')!
      expect(stored.fingerprint).toBe('f1')
    } finally {
      store.close()
    }
  })

  it('accounts shared bytes by artifact and never stores file content in events', async () => {
    const store = await openStore()
    try {
      const bots = new BotRepository(store)
      const teams = new TeamRepository(store)
      seedBots(bots, ['a', 'b'])
      seedTeam(teams, store.hostId, ['a', 'b'])
      const digest = 'a'.repeat(64)
      teams.saveArtifact({
        id: 'art-1',
        teamId: 'team-1',
        name: 'dados.csv',
        size: 1024,
        digest,
        version: 1,
        origin: { kind: 'human' },
        state: 'available',
        createdAt: stamp,
        updatedAt: stamp,
      })
      expect(teams.sharedBytes('team-1')).toBe(1024)
      teams.saveArtifact({
        id: 'art-2',
        teamId: 'team-1',
        name: 'dados.csv',
        size: 2048,
        digest: 'b'.repeat(64),
        version: 1,
        origin: { kind: 'bot', botId: 'b', runId: 'run-1' },
        state: 'revoked',
        revokedAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      })
      // Revoked copies stop consuming the team quota; identical names never collide.
      expect(teams.sharedBytes('team-1')).toBe(1024)
      expect(teams.artifacts('team-1').map((a) => a.id)).toEqual(['art-1'])
      expect(teams.artifacts('team-1', true)).toHaveLength(2)
      const event = teams.appendEvent({ teamId: 'team-1', kind: 'artifact.shared', summary: 'Arquivo compartilhado', detail: { artifactId: 'art-1', digest }, createdAt: stamp })
      expect(event.seq).toBe(1)
      const page = teams.events('team-1', 0, 10)
      expect(page.events).toHaveLength(1)
      expect(JSON.stringify(page.events)).not.toContain('dataBase64')
    } finally {
      store.close()
    }
  })
})
