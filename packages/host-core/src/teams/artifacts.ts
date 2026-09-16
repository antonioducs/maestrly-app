import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FILE_CHUNK_BYTES,
  TEAM_LIMITS,
  TRANSFER_FILE_MAX,
  type Bot,
  type TeamArtifact,
  type TeamArtifactGrant,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { GuestSession } from '../guest/session.js'
import type { BotRepository } from '../bots/repository.js'
import { workspacePath } from '../bots/files.js'
import { type TeamRepository, now } from './repository.js'

/** Names that reach a guest workspace are generated, never echoed from a model or a path. */
export function safeName(value: string): string {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? 'arquivo'
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 120)
  return cleaned || 'arquivo'
}
/** Workspace-relative destination of a shared copy, unique per team, run and artifact. */
export const deliveryPath = (artifact: TeamArtifact, runId: string) =>
  workspacePath(`equipe/${runId.slice(0, 8)}/${artifact.id.slice(0, 8)}-${safeName(artifact.name)}`)

export interface TeamArtifactsDeps {
  teams: TeamRepository
  bots: BotRepository
  stateDirectory: string
  session: (bot: Bot) => Promise<GuestSession>
  /** Free bytes available for new shared copies on the Host. */
  freeBytes?: () => number
}

/**
 * Shared files are verified immutable copies held by the Host, not a writable folder that
 * two guests can see. Publishing copies bytes out of one workspace, checks size and
 * SHA-256, and only then becomes shareable; delivering copies them into the recipient's own
 * workspace under a generated path. A recipient never learns a Host path, never receives a
 * symlink into another session and never overwrites a file it already had.
 */
export class TeamArtifacts {
  constructor(private readonly deps: TeamArtifactsDeps) {}

  private directory(teamId: string) {
    const path = join(this.deps.stateDirectory, 'teams', teamId, 'artifacts')
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.()) throw new HostError('INVALID_PATH', 'Diretório de arquivos da equipe inválido')
    chmodSync(path, 0o700)
    return path
  }
  path(artifact: Pick<TeamArtifact, 'id' | 'teamId'>) {
    return join(this.directory(artifact.teamId), artifact.id)
  }

  /** Admission is transactional: two concurrent shares cannot both fit into the last MiB. */
  private admit(teamId: string, size: number): TeamArtifact {
    if (size > TRANSFER_FILE_MAX) throw new HostError('LIMIT', `Arquivo maior que o limite de ${TRANSFER_FILE_MAX} bytes`)
    return this.deps.teams.transaction(() => {
      const used = this.deps.teams.sharedBytes(teamId)
      if (used + size > TEAM_LIMITS.shareQuotaBytes)
        throw new HostError('TEAM_QUOTA_EXCEEDED', 'A equipe atingiu o limite de arquivos compartilhados; remova algum antes de compartilhar outro.')
      if (this.deps.teams.artifacts(teamId, true).length >= TEAM_LIMITS.artifactsPerTeamMax)
        throw new HostError('TEAM_QUOTA_EXCEEDED', 'A equipe já tem arquivos compartilhados demais')
      const free = this.deps.freeBytes?.()
      if (typeof free === 'number' && free < size + 64 * 1024 * 1024)
        throw new HostError('CAPACITY_EXCEEDED', 'Não há espaço livre suficiente no Host para guardar este arquivo compartilhado.')
      return { id: randomUUID(), teamId, size } as TeamArtifact
    })
  }

  /**
   * Copies a file out of one bot's workspace into the team store. The file is read in
   * bounded chunks, hashed while it streams, and promoted only if size and digest match
   * what the guest declared; a file that changes mid-read fails with FILE_CHANGED and
   * leaves no staged remains.
   */
  async publish(input: {
    teamId: string
    bot: Bot
    path: string
    name?: string
    origin: TeamArtifact['origin']
    runId?: string
    taskId?: string
  }): Promise<TeamArtifact> {
    const relative = workspacePath(input.path)
    const session = await this.deps.session(input.bot)
    const info = (await session.request('files.stat', { path: relative })) as { kind: string; size: number; digest: string }
    if (info.kind !== 'file') throw new HostError('INVALID_PATH', 'Somente arquivos podem ser compartilhados')
    const reserved = this.admit(input.teamId, info.size)
    const target = join(this.directory(input.teamId), reserved.id)
    const staging = `${target}.staging`
    const hash = createHash('sha256')
    const handle = await open(staging, 'wx', 0o600)
    let written = 0
    try {
      while (written < info.size) {
        const length = Math.min(FILE_CHUNK_BYTES, info.size - written)
        const chunk = (await session.request('files.read', { path: relative, offset: written, length })) as { dataBase64: string; digest: string }
        if (chunk.digest !== info.digest) throw new HostError('FILE_CHANGED', 'O arquivo mudou durante o compartilhamento; tente novamente')
        const bytes = Buffer.from(chunk.dataBase64, 'base64')
        if (!bytes.length) throw new HostError('RUNTIME_PROTOCOL', 'O computador do bot devolveu um pedaço vazio')
        hash.update(bytes)
        await handle.write(bytes, 0, bytes.length, written)
        written += bytes.length
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    const digest = hash.digest('hex')
    if (written !== info.size || digest !== info.digest) {
      await rm(staging, { force: true })
      throw new HostError('FILE_CHANGED', 'A verificação do arquivo compartilhado falhou; nada foi publicado')
    }
    await rename(staging, target)
    const version = this.deps.teams.artifacts(input.teamId, true).filter((existing) => existing.name === safeName(input.name ?? relative)).length + 1
    const artifact: TeamArtifact = {
      id: reserved.id,
      teamId: input.teamId,
      name: safeName(input.name ?? relative),
      size: written,
      digest,
      version,
      origin: input.origin,
      state: 'available',
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      createdAt: now(),
      updatedAt: now(),
    }
    this.deps.teams.transaction(() => this.deps.teams.saveArtifact(artifact))
    return artifact
  }

  /** Reserves an artifact for a person's upload; bytes arrive through the transfer methods. */
  beginUpload(teamId: string, name: string, size: number, digest?: string): TeamArtifact {
    const reserved = this.admit(teamId, size)
    const artifact: TeamArtifact = {
      id: reserved.id,
      teamId,
      name: safeName(name),
      size,
      digest: digest ?? '0'.repeat(64),
      version: this.deps.teams.artifacts(teamId, true).filter((existing) => existing.name === safeName(name)).length + 1,
      origin: { kind: 'human' },
      state: 'staging',
      createdAt: now(),
      updatedAt: now(),
    }
    this.deps.teams.transaction(() => this.deps.teams.saveArtifact(artifact))
    return artifact
  }
  async writeChunk(artifact: TeamArtifact, offset: number, bytes: Buffer) {
    const handle = await open(`${this.path(artifact)}.staging`, offset === 0 ? 'w' : 'r+', 0o600)
    try {
      await handle.write(bytes, 0, bytes.length, offset)
    } finally {
      await handle.close()
    }
  }
  /** Promotion happens only after the whole copy hashes to what the caller declared. */
  async promote(artifact: TeamArtifact): Promise<TeamArtifact> {
    const staging = `${this.path(artifact)}.staging`
    const info = await stat(staging).catch(() => undefined)
    if (!info || info.size !== artifact.size) {
      await rm(staging, { force: true })
      this.deps.teams.transaction(() => this.deps.teams.saveArtifact({ ...artifact, state: 'revoked', revokedAt: now(), updatedAt: now() }))
      throw new HostError('TRANSFER_INCOMPLETE', 'O arquivo não chegou por inteiro; nada foi compartilhado')
    }
    const hash = createHash('sha256')
    const handle = await open(staging, 'r')
    try {
      const buffer = Buffer.alloc(FILE_CHUNK_BYTES)
      for (let offset = 0; offset < artifact.size; ) {
        const read = await handle.read(buffer, 0, Math.min(buffer.length, artifact.size - offset), offset)
        if (!read.bytesRead) break
        hash.update(buffer.subarray(0, read.bytesRead))
        offset += read.bytesRead
      }
    } finally {
      await handle.close()
    }
    const digest = hash.digest('hex')
    if (artifact.digest !== '0'.repeat(64) && digest !== artifact.digest) {
      await rm(staging, { force: true })
      throw new HostError('FILE_CHANGED', 'O conteúdo recebido não confere com o resumo informado')
    }
    await rename(staging, this.path(artifact))
    const promoted: TeamArtifact = { ...artifact, digest, state: 'available', updatedAt: now() }
    this.deps.teams.transaction(() => this.deps.teams.saveArtifact(promoted))
    return promoted
  }
  async abort(artifact: TeamArtifact) {
    await rm(`${this.path(artifact)}.staging`, { force: true })
    this.deps.teams.transaction(() => this.deps.teams.saveArtifact({ ...artifact, state: 'revoked', revokedAt: now(), updatedAt: now() }))
  }
  async read(artifact: TeamArtifact, offset: number, length: number): Promise<Buffer> {
    const handle = await open(this.path(artifact), 'r')
    try {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, artifact.size - offset)))
      if (!buffer.length) return buffer
      const result = await handle.read(buffer, 0, buffer.length, offset)
      return buffer.subarray(0, result.bytesRead)
    } finally {
      await handle.close()
    }
  }

  /**
   * Writes a verified copy into the recipient's own workspace. An identical copy already
   * there is accepted as delivered; a different file under the same generated name is a
   * conflict, never a silent overwrite.
   */
  async deliver(grant: TeamArtifactGrant): Promise<TeamArtifactGrant> {
    const artifact = this.deps.teams.artifact(grant.artifactId)
    if (artifact.state !== 'available' || grant.state === 'revoked')
      throw new HostError('TEAM_GRANT_REVOKED', 'Este arquivo não está mais disponível para a equipe')
    const bot = this.deps.bots.bot(grant.botId)
    const session = await this.deps.session(bot)
    const existing = (await session.request('files.stat', { path: grant.path }).catch(() => null)) as { kind: string; digest: string } | null
    if (existing) {
      if (existing.digest === artifact.digest) return this.markDelivered(grant)
      throw new HostError('FILE_EXISTS', 'Já existe outro arquivo neste caminho do espaço de trabalho do bot')
    }
    const transferId = `${grant.id}:deliver`
    for (let offset = 0; offset < artifact.size || offset === 0; ) {
      const bytes = await this.read(artifact, offset, FILE_CHUNK_BYTES)
      const final = offset + bytes.length >= artifact.size
      await session.request('files.write', {
        transferId,
        path: grant.path,
        offset,
        dataBase64: bytes.toString('base64'),
        final,
        expectedDigest: artifact.digest,
        overwrite: false,
      })
      offset += bytes.length
      if (final) break
    }
    return this.markDelivered(grant)
  }
  private markDelivered(grant: TeamArtifactGrant) {
    const delivered: TeamArtifactGrant = { ...grant, state: 'delivered', updatedAt: now() }
    this.deps.teams.transaction(() => this.deps.teams.saveGrant(delivered))
    return delivered
  }

  /**
   * Revocation stops new reads and new deliveries immediately and invalidates pending
   * grants. Copies already written into a workspace are gone from the Host's reach: the
   * caller is told that, instead of being promised a remote deletion that cannot happen.
   */
  revoke(artifactId: string): { artifact: TeamArtifact; deliveredTo: string[] } {
    return this.deps.teams.transaction(() => {
      const artifact = this.deps.teams.artifact(artifactId)
      const delivered: string[] = []
      for (const grant of this.deps.teams.grantsOfArtifact(artifactId)) {
        if (grant.state === 'delivered') delivered.push(grant.botId)
        this.deps.teams.saveGrant({ ...grant, state: 'revoked', updatedAt: now() })
      }
      const revoked: TeamArtifact = { ...artifact, state: 'revoked', revokedAt: now(), updatedAt: now() }
      this.deps.teams.saveArtifact(revoked)
      return { artifact: revoked, deliveredTo: delivered }
    })
  }
  async purge(artifact: TeamArtifact) {
    await rm(this.path(artifact), { force: true })
    await rm(`${this.path(artifact)}.staging`, { force: true })
  }
}
