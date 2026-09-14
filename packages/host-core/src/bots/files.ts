import { randomUUID } from 'node:crypto'
import { TRANSFER_CHUNK_BYTES, TRANSFER_FILE_MAX, botFileSchema, type Bot, type TransferState } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { GuestSession } from '../guest/session.js'
import { type BotRepository, now } from './repository.js'

const TRANSFER_TTL_MS = 30 * 60_000
/** Workspace-relative paths only; the guest re-validates symlinks, devices and ownership. */
export function workspacePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (
    normalized.length > 512 ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '..' || part === '.' ) ||
    /^[A-Za-z]:/.test(normalized)
  )
    throw new HostError('INVALID_PATH', 'Use um caminho relativo dentro do espaço de trabalho do bot')
  return normalized
}
export class BotFiles {
  constructor(
    private readonly repo: BotRepository,
    private readonly session: (bot: Bot) => Promise<GuestSession>
  ) {}
  async list(botId: string, path: string) {
    const bot = this.repo.bot(botId)
    const relative = path ? workspacePath(path) : ''
    const session = await this.session(bot)
    const result = await session.request('files.list', { path: relative })
    if (!Array.isArray(result) || result.length > 2000) throw new HostError('RUNTIME_PROTOCOL', 'Invalid file listing')
    return result.map((entry) => botFileSchema.parse(entry))
  }
  async begin(botId: string, input: { direction: 'upload' | 'download'; path: string; size?: number; digest?: string; overwrite: boolean }): Promise<TransferState> {
    const bot = this.repo.bot(botId)
    const path = workspacePath(input.path)
    const session = await this.session(bot)
    let size = input.size ?? 0
    let digest = input.digest
    if (input.direction === 'download') {
      const stat = (await session.request('files.stat', { path })) as { size: number; digest: string; kind: string }
      if (stat.kind !== 'file') throw new HostError('INVALID_PATH', 'Somente arquivos podem ser baixados')
      if (stat.size > TRANSFER_FILE_MAX) throw new HostError('LIMIT', `Arquivo maior que o limite de ${TRANSFER_FILE_MAX} bytes`)
      size = stat.size
      digest = stat.digest
    } else {
      if (size > TRANSFER_FILE_MAX) throw new HostError('LIMIT', `Arquivo maior que o limite de ${TRANSFER_FILE_MAX} bytes`)
      if (!input.overwrite) {
        const existing = (await session.request('files.stat', { path }).catch(() => null)) as { kind: string } | null
        if (existing) throw new HostError('FILE_EXISTS', 'Já existe um arquivo com este nome; confirme a substituição')
      }
    }
    const transfer: TransferState = {
      transferId: randomUUID(),
      direction: input.direction,
      path,
      size,
      offset: 0,
      chunkBytes: TRANSFER_CHUNK_BYTES,
      ...(digest ? { digest } : {}),
      done: size === 0 && input.direction === 'download',
      expiresAt: new Date(Date.now() + TRANSFER_TTL_MS).toISOString(),
    }
    this.repo.transaction(() => this.repo.saveTransfer(botId, transfer))
    return transfer
  }
  private load(transferId: string) {
    const transfer = this.repo.transfer(transferId)
    if (new Date(transfer.expiresAt).getTime() < Date.now()) {
      this.repo.deleteTransfer(transferId)
      throw new HostError('TRANSFER_EXPIRED', 'A transferência expirou; comece novamente')
    }
    return transfer
  }
  async chunk(transferId: string, offset: number, dataBase64?: string): Promise<TransferState> {
    const transfer = this.load(transferId)
    if (offset !== transfer.offset) throw new HostError('TRANSFER_OFFSET', `Deslocamento inesperado; retome a partir de ${transfer.offset}`)
    const bot = this.repo.bot(transfer.botId)
    const session = await this.session(bot)
    const { botId, ...state } = transfer
    if (transfer.direction === 'download') {
      const length = Math.min(TRANSFER_CHUNK_BYTES, transfer.size - offset)
      const result = (await session.request('files.read', { path: transfer.path, offset, length })) as { dataBase64: string; digest: string }
      if (result.digest !== transfer.digest) throw new HostError('FILE_CHANGED', 'O arquivo mudou durante a transferência; comece novamente')
      const bytes = Buffer.from(result.dataBase64, 'base64').length
      const next: TransferState = { ...state, offset: offset + bytes, dataBase64: result.dataBase64, done: offset + bytes >= transfer.size }
      this.repo.transaction(() => this.repo.saveTransfer(botId, { ...next, dataBase64: undefined }))
      return next
    }
    if (!dataBase64) throw new HostError('INVALID_REQUEST', 'Chunk data required for upload')
    const bytes = Buffer.from(dataBase64, 'base64')
    if (bytes.length > TRANSFER_CHUNK_BYTES || offset + bytes.length > transfer.size) throw new HostError('LIMIT', 'Chunk exceeds declared size')
    const final = offset + bytes.length >= transfer.size
    await session.request('files.write', { transferId, path: transfer.path, offset, dataBase64, final, expectedDigest: transfer.digest, overwrite: true })
    const next: TransferState = { ...state, offset: offset + bytes.length, done: final }
    this.repo.transaction(() => this.repo.saveTransfer(botId, next))
    return next
  }
  async finish(transferId: string): Promise<TransferState> {
    const transfer = this.load(transferId)
    if (!transfer.done) throw new HostError('TRANSFER_INCOMPLETE', 'A transferência ainda não terminou')
    this.repo.deleteTransfer(transferId)
    const { botId: _botId, ...state } = transfer
    return state
  }
  async abort(transferId: string): Promise<TransferState> {
    const transfer = this.repo.transfer(transferId)
    if (transfer.direction === 'upload') {
      const bot = this.repo.bot(transfer.botId)
      await this.session(bot)
        .then((session) => session.request('files.abort', { transferId }))
        .catch(() => {})
    }
    this.repo.deleteTransfer(transferId)
    const { botId: _botId, ...state } = transfer
    return { ...state, done: false, expiresAt: now() }
  }
}
