import { afterEach, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { TEAM_LIMITS } from '@maestrly/host-protocol'
import { ask, collaborate, createTeam, finishTurn, runOf, teamBot, teamLab, turnOf, until, type TeamLab } from './team-helpers.js'
import { HostError } from '../src/errors.js'

const labs: TeamLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) {
    await lab.service.close()
    await rm(lab.dir, { recursive: true, force: true })
  }
})
const skip = process.platform === 'win32'
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function trio() {
  const lab = await teamLab()
  labs.push(lab)
  const ana = await teamBot(lab, 'Ana')
  const bruno = await teamBot(lab, 'Bruno', ana.vmId)
  const carla = await teamBot(lab, 'Carla', ana.vmId)
  const team = await createTeam(lab, {
    name: 'Arquivos',
    members: [{ botId: ana.id, coordinator: true }, { botId: bruno.id }, { botId: carla.id }],
  })
  return { lab, ana, bruno, carla, team: team.team }
}

it.skipIf(skip)('delivers a verified copy to the recipient and to nobody else', async () => {
  const { lab, ana, bruno, carla, team } = await trio()
  const csv = Buffer.from('produto,valor\na,10\nb,32\n')
  lab.guest(ana.id).files.set('dados.csv', csv)
  const share = await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'share-1', botId: ana.id, path: 'dados.csv' })
  expect(share.status).toBe('succeeded')
  const artifact = (await lab.call('team.artifacts.list', { teamId: team.id }))[0]
  expect(artifact).toMatchObject({ name: 'dados.csv', size: csv.length, digest: sha(csv), state: 'available' })
  // The public record names identity, version and digest — never a Host path.
  expect(JSON.stringify(artifact)).not.toContain(lab.dir)

  const receipt = await ask(lab, team.id, 'some a coluna valor', [artifact.id])
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', {
    tasks: [{ localKey: 'analise', assigneeBotId: bruno.id, goal: 'some a coluna valor', inputArtifactIds: [artifact.id] }],
  })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const worker = await turnOf(lab, receipt.run.id, bruno.id)

  const delivered = [...lab.guest(bruno.id).files.entries()].find(([path]) => path.startsWith('equipe/'))!
  expect(sha(delivered[1])).toBe(sha(csv))
  expect(delivered[0]).not.toContain('..')
  expect(delivered[0]).not.toMatch(/^\//)
  // Carla has no grant in this run and receives nothing.
  expect([...lab.guest(carla.id).files.keys()]).toHaveLength(0)
  // The snapshot points at the copy inside the member's own workspace.
  const snapshot = lab.guest(bruno.id).turns.get(worker.id)!.snapshot
  expect(snapshot.team.resources).toMatchObject([{ name: 'dados.csv', path: delivered[0], digest: sha(csv) }])
  expect(JSON.stringify(snapshot.team.resources)).not.toContain(lab.dir)
})

it.skipIf(skip)('publishes a member result without touching anyone else’s files', async () => {
  const { lab, ana, bruno, team } = await trio()
  const receipt = await ask(lab, team.id, 'produza o relatório')
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', { tasks: [{ localKey: 'relatorio', assigneeBotId: bruno.id, goal: 'escreva o relatório' }] })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const worker = await turnOf(lab, receipt.run.id, bruno.id)

  const output = Buffer.from('# Relatório\nSoma: 42\n')
  lab.guest(bruno.id).files.set('saida/relatorio.md', output)
  // Ana already has a private file with the same name and different content.
  lab.guest(ana.id).files.set('saida/relatorio.md', Buffer.from('rascunho da Ana'))
  const published = await collaborate(lab, bruno.id, worker.id, 'team_publish_file', { path: 'saida/relatorio.md' })
  expect(published.status).toBe('succeeded')
  expect(published.artifact.digest).toBe(sha(output))
  // Identity, not name, decides: Ana's private file is untouched.
  expect(lab.guest(ana.id).files.get('saida/relatorio.md')!.toString()).toBe('rascunho da Ana')

  finishTurn(lab, bruno.id, worker.id, 'relatório pronto')
  const review = await turnOf(lab, receipt.run.id, ana.id)
  const snapshot = lab.guest(ana.id).turns.get(review.id)!.snapshot
  expect(snapshot.team.resources.some((resource: any) => resource.digest === sha(output))).toBe(true)
  expect(snapshot.team.resources.every((resource: any) => resource.path.startsWith('equipe/'))).toBe(true)
})

it.skipIf(skip)('refuses traversal, absolute paths and a missing file when sharing', async () => {
  const { lab, ana, team } = await trio()
  for (const path of ['../fora.txt', '/etc/passwd', './../../x', 'a/../../b'])
    await expect(lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: `bad-${path}`, botId: ana.id, path })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    })
  const missing = await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'missing', botId: ana.id, path: 'nao-existe.txt' })
  expect(missing.status).toBe('failed')
  expect(await lab.call('team.artifacts.list', { teamId: team.id })).toEqual([])
})

it.skipIf(skip)('fails honestly when the file changes during the copy and leaves nothing staged', async () => {
  const { lab, ana, team } = await trio()
  const guest = lab.guest(ana.id)
  const original = Buffer.alloc(120 * 1024, 'a')
  guest.files.set('grande.bin', original)
  let reads = 0
  guest.handler = (method) => {
    if (method === 'files.read') {
      reads++
      // The file is replaced after the first chunk, exactly as a live edit would.
      if (reads === 2) guest.files.set('grande.bin', Buffer.alloc(120 * 1024, 'b'))
    }
    return undefined
  }
  const result = await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'changed', botId: ana.id, path: 'grande.bin' })
  expect(result).toMatchObject({ status: 'failed', error: { code: 'FILE_CHANGED' } })
  expect(await lab.call('team.artifacts.list', { teamId: team.id })).toEqual([])
  expect(await lab.call('team.artifacts.list', { teamId: team.id, includeRevoked: true })).toEqual([])
})

it.skipIf(skip)('revokes access, blocks new deliveries and says what cannot be undone', async () => {
  const { lab, ana, bruno, carla, team } = await trio()
  const data = Buffer.from('conteúdo compartilhado')
  lab.guest(ana.id).files.set('base.txt', data)
  await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'share', botId: ana.id, path: 'base.txt' })
  const artifact = (await lab.call('team.artifacts.list', { teamId: team.id }))[0]

  const receipt = await ask(lab, team.id, 'use o arquivo', [artifact.id])
  const planning = await turnOf(lab, receipt.run.id, ana.id)
  await collaborate(lab, ana.id, planning.id, 'team_delegate', {
    tasks: [
      { localKey: 'um', assigneeBotId: bruno.id, goal: 'leia o arquivo' },
      { localKey: 'dois', assigneeBotId: carla.id, goal: 'depois use o arquivo', dependsOn: ['um'] },
    ],
  })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const brunoTurn = await turnOf(lab, receipt.run.id, bruno.id)
  expect([...lab.guest(bruno.id).files.keys()].some((path) => path.startsWith('equipe/'))).toBe(true)

  const revoked = await lab.call('team.artifacts.revoke', { teamId: team.id, artifactId: artifact.id, idempotencyKey: 'revoke' })
  expect(revoked.state).toBe('revoked')
  const events = await lab.call('team.events.list', { teamId: team.id })
  const notice = events.events.find((event: any) => event.kind === 'artifact.revoked')
  // The person is told that copies already delivered cannot be removed remotely. Two
  // members legitimately hold one: the coordinator, who planned over the attached file,
  // and Bruno, who was given it for his task.
  expect(notice.summary).toContain('não podem ser apagadas remotamente')
  expect(notice.detail.deliveredCopies).toBe(2)

  finishTurn(lab, bruno.id, brunoTurn.id, 'li o arquivo')
  // Carla's task runs next but never receives the revoked file.
  await until(
    () => lab.call('team.tasks.list', { runId: receipt.run.id }),
    (page: any) => ['needs_attention', 'running', 'succeeded', 'failed'].includes(page.tasks.find((task: any) => task.localKey === 'dois').status)
  )
  expect([...lab.guest(carla.id).files.keys()].filter((path) => path.startsWith('equipe/'))).toHaveLength(0)
  expect(await lab.call('team.artifacts.list', { teamId: team.id })).toEqual([])
})

it.skipIf(skip)('enforces the team quota and the per-file limit transactionally', async () => {
  const { lab, ana, team } = await trio()
  lab.guest(ana.id).files.set('pequeno.txt', Buffer.from('ok'))
  await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'ok', botId: ana.id, path: 'pequeno.txt' })
  // A file above the transfer limit is refused before any byte is copied.
  const guest = lab.guest(ana.id)
  guest.handler = (method, params) => (method === 'files.stat' && (params as any).path === 'enorme.bin' ? { kind: 'file', size: 64 * 1024 * 1024, digest: 'f'.repeat(64) } : undefined)
  const tooBig = await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'too-big', botId: ana.id, path: 'enorme.bin' })
  expect(tooBig).toMatchObject({ status: 'failed', error: { code: 'LIMIT' } })
  guest.handler = () => undefined
  expect(TEAM_LIMITS.shareQuotaBytes).toBe(256 * 1024 * 1024)
  expect(await lab.call('team.artifacts.list', { teamId: team.id })).toHaveLength(1)
})

it.skipIf(skip)('uploads and downloads a shared file through verified chunks only', async () => {
  const { lab, team } = await trio()
  const content = Buffer.from('linha1\nlinha2\n'.repeat(500))
  const begin = await lab.call('team.artifacts.transferBegin', { teamId: team.id, direction: 'upload', name: 'planilha.csv', size: content.length, digest: sha(content) })
  let state = begin
  for (let offset = 0; offset < content.length; offset += state.chunkBytes)
    state = await lab.call('team.artifacts.transferChunk', {
      transferId: begin.transferId,
      offset,
      dataBase64: content.subarray(offset, offset + state.chunkBytes).toString('base64'),
    })
  const finished = await lab.call('team.artifacts.transferFinish', { transferId: begin.transferId })
  expect(finished.artifact).toMatchObject({ state: 'available', digest: sha(content), size: content.length })

  const download = await lab.call('team.artifacts.transferBegin', { teamId: team.id, direction: 'download', artifactId: finished.artifact.id })
  const chunks: Buffer[] = []
  let cursor = download
  while (!cursor.done) {
    cursor = await lab.call('team.artifacts.transferChunk', { transferId: download.transferId, offset: cursor.offset })
    chunks.push(Buffer.from(cursor.dataBase64, 'base64'))
  }
  expect(sha(Buffer.concat(chunks))).toBe(sha(content))
  await lab.call('team.artifacts.transferFinish', { transferId: download.transferId })
})

it.skipIf(skip)('discards an upload whose content does not match the declared digest', async () => {
  const { lab, team } = await trio()
  const declared = Buffer.from('conteúdo correto')
  const sent = Buffer.from('conteúdo trocado')
  const begin = await lab.call('team.artifacts.transferBegin', { teamId: team.id, direction: 'upload', name: 'x.txt', size: sent.length, digest: sha(declared) })
  await lab.call('team.artifacts.transferChunk', { transferId: begin.transferId, offset: 0, dataBase64: sent.toString('base64') })
  await expect(lab.call('team.artifacts.transferFinish', { transferId: begin.transferId })).rejects.toMatchObject({ code: 'FILE_CHANGED' })
  expect(await lab.call('team.artifacts.list', { teamId: team.id })).toEqual([])
})

it.skipIf(skip)('retries a delivery while the computer is still waking up, instead of asking for help', async () => {
  const { lab, ana, bruno, team } = await trio()
  const csv = Buffer.from('produto,valor\na,10\nb,32\n')
  lab.guest(ana.id).files.set('dados.csv', csv)
  await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'share-slow', botId: ana.id, path: 'dados.csv' })
  const artifact = (await lab.call('team.artifacts.list', { teamId: team.id }))[0]
  // The graphical session of a bot starts on demand: the first attempts find nothing listening.
  let refusals = 0
  lab.connector.handler = (method) => {
    if (method === 'files.write' && refusals < 1) {
      refusals++
      throw new HostError('RUNTIME_UNREACHABLE', 'Guest control channel closed')
    }
    return undefined
  }
  const receipt = await ask(lab, team.id, 'analise o csv', [artifact.id])

  // The work proceeds once the session answers; a person is never asked to fix a transient wait.
  // Retries are spaced by the scheduler tick, so this waits longer than an immediate dispatch.
  const planning = await until(
    async () => (await lab.call('team.tasks.list', { runId: receipt.run.id })).turns.find((turn: any) => turn.botId === ana.id),
    (turn) => !!turn,
    20_000
  )
  expect(refusals).toBeGreaterThan(0)
  const tasks = (await lab.call('team.tasks.list', { runId: receipt.run.id })).tasks
  expect(tasks.every((task: any) => task.status !== 'needs_attention')).toBe(true)
  expect((await runOf(lab, receipt.run.id)).status).toBe('planning')
  // The copy that finally arrived is the verified one, not a half-written retry.
  expect(lab.guest(ana.id).files.get(`equipe/${receipt.run.id.slice(0, 8)}/${artifact.id.slice(0, 8)}-dados.csv`)).toEqual(csv)

  await collaborate(lab, ana.id, planning.id, 'team_delegate', { tasks: [{ localKey: 'a', assigneeBotId: bruno.id, goal: 'some', inputArtifactIds: [artifact.id] }] })
  finishTurn(lab, ana.id, planning.id, 'distribuí')
  const worker = await turnOf(lab, receipt.run.id, bruno.id)
  expect(worker).toBeTruthy()
})

it.skipIf(skip)('gives up with the real reason when the delivery keeps failing', async () => {
  const { lab, ana, team } = await trio()
  const csv = Buffer.from('produto,valor\na,10\n')
  lab.guest(ana.id).files.set('dados.csv', csv)
  await lab.call('team.artifacts.share', { teamId: team.id, idempotencyKey: 'share-broken', botId: ana.id, path: 'dados.csv' })
  const artifact = (await lab.call('team.artifacts.list', { teamId: team.id }))[0]
  // A refusal that is not transient must be reported at once, with its stable code.
  lab.connector.handler = (method) => {
    if (method === 'files.write') throw new HostError('FILE_EXISTS', 'Já existe um arquivo com este nome')
    return undefined
  }
  const receipt = await ask(lab, team.id, 'analise o csv', [artifact.id])
  const stuck = await until(
    async () => (await lab.call('team.tasks.list', { runId: receipt.run.id })).tasks[0],
    (task: any) => task?.status === 'needs_attention'
  )
  // The message names the next step instead of a generic failure.
  expect(stuck.attention).toContain('Já existe um arquivo com este nome')
  const events = (await lab.call('team.events.list', { teamId: team.id, limit: 50 })).events
  expect(events.find((event: any) => event.kind === 'attention')?.detail?.code).toBe('FILE_EXISTS')
})
