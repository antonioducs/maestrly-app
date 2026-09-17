import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SKILL_MAX_BYTES,
  SKILL_MAX_FILES,
  extensionResultSchemas,
  type ExtensionMethod,
  type ExtensionRequest,
  type ExtensionResult,
  type ExtensionsApply,
  type ExtensionsState,
  type McpServer,
  type SkillSummary,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { HostStore } from '../persistence/store.js'
import type { BotRepository } from '../bots/repository.js'
import { privateDirectory, readPrivate, writePrivate } from '../accounts/private-files.js'
import { ExtensionsRepository } from './extensions-repository.js'

/** The description a skill declares in the frontmatter of its SKILL.md; the model reads only this until it opens the skill. */
export function skillDescription(skillMd: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)
  if (!match) return undefined
  const line = match[1].split(/\r?\n/).find((entry) => /^description\s*:/.test(entry))
  return line ? line.replace(/^description\s*:\s*/, '').replace(/^["']|["']$/g, '').trim() : undefined
}

/** Content digest of a skill: every file, in path order, so a changed byte changes the identity. */
export function skillDigest(files: { path: string; data: Buffer }[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.data)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Per-bot extensions: MCP servers and skills. Configuration lives in SQLite; secret values
 * and skill files live in the Host's private state directory and only leave it inside
 * `extensions.apply`, on the private channel to that bot's guest.
 */
export class ExtensionsService {
  readonly repo: ExtensionsRepository
  constructor(
    store: HostStore,
    private readonly bots: BotRepository,
    private readonly stateDirectory: string
  ) {
    this.repo = new ExtensionsRepository(store)
  }
  private root(botId: string) {
    return join(this.stateDirectory, 'extensions', botId)
  }
  private secretPath(botId: string, serverId: string) {
    return join(this.root(botId), 'secrets', `${serverId}.json`)
  }
  private skillPath(botId: string, name: string) {
    return join(this.root(botId), 'skills', name)
  }

  async handle<M extends ExtensionMethod>(request: Extract<ExtensionRequest, { method: M }>): Promise<ExtensionResult<M>> {
    const result = await this.dispatch(request as ExtensionRequest)
    return extensionResultSchemas[request.method].parse(result) as ExtensionResult<M>
  }
  private async dispatch(request: ExtensionRequest): Promise<ExtensionsState> {
    const p = request.params as Record<string, unknown>
    const botId = p.botId as string
    this.bots.bot(botId)
    if (request.method === 'extension.inspect') return this.repo.state(botId)
    const current = this.repo.state(botId)
    if (current.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'As extensões deste bot mudaram; recarregue antes de editar')
    switch (request.method) {
      case 'extension.mcp.upsert':
        return this.upsertServer(current, p.server as McpServer & { env: Record<string, string> })
      case 'extension.mcp.remove':
        return this.removeServer(current, p.serverId as string)
      case 'extension.skill.install':
        return this.installSkill(current, p.name as string, p.files as { path: string; dataBase64: string }[])
      case 'extension.skill.remove':
        return this.removeSkill(current, p.name as string)
      case 'extension.skill.setEnabled':
        return this.setSkillEnabled(current, p.name as string, p.enabled as boolean)
    }
  }

  private async upsertServer(current: ExtensionsState, input: McpServer & { env: Record<string, string> }): Promise<ExtensionsState> {
    const { env, envKeys: _ignored, ...server } = input
    const existing = current.mcpServers.find((s) => s.id === server.id)
    if (!existing && current.mcpServers.some((s) => s.name === server.name)) throw new HostError('MCP_NAME_TAKEN', 'Já existe um servidor com este nome neste bot')
    if (!existing && current.mcpServers.length >= 16) throw new HostError('LIMIT', 'Este bot já tem o máximo de servidores MCP')
    const id = existing?.id ?? server.id ?? randomUUID()
    // Secrets: what was stored stays unless the person named the key; an empty value removes it.
    const stored = existing ? await this.readSecrets(current.botId, id) : {}
    const merged: Record<string, string> = { ...stored }
    for (const [key, value] of Object.entries(env)) {
      if (value === '') delete merged[key]
      else merged[key] = value
    }
    await writePrivate(this.secretPath(current.botId, id), JSON.stringify(merged))
    const saved: McpServer = { ...server, id, envKeys: Object.keys(merged).sort(), args: server.args ?? [], enabled: server.enabled ?? true }
    const mcpServers = existing ? current.mcpServers.map((s) => (s.id === id ? saved : s)) : [...current.mcpServers, saved]
    return this.commit(current, mcpServers)
  }
  private async removeServer(current: ExtensionsState, serverId: string): Promise<ExtensionsState> {
    if (!current.mcpServers.some((s) => s.id === serverId)) return current
    await rm(this.secretPath(current.botId, serverId), { force: true })
    return this.commit(
      current,
      current.mcpServers.filter((s) => s.id !== serverId)
    )
  }
  private async installSkill(current: ExtensionsState, name: string, input: { path: string; dataBase64: string }[]): Promise<ExtensionsState> {
    if (input.length > SKILL_MAX_FILES) throw new HostError('SKILL_TOO_LARGE', `Uma skill tem no máximo ${SKILL_MAX_FILES} arquivos`)
    const files = input.map((file) => ({ path: file.path, data: Buffer.from(file.dataBase64, 'base64') }))
    const bytes = files.reduce((sum, file) => sum + file.data.length, 0)
    if (bytes > SKILL_MAX_BYTES) throw new HostError('SKILL_TOO_LARGE', 'Esta skill passa do tamanho máximo permitido')
    const manifest = files.find((file) => file.path === 'SKILL.md')
    if (!manifest) throw new HostError('SKILL_INVALID', 'Uma skill precisa de um SKILL.md na raiz')
    const description = skillDescription(manifest.data.toString('utf8'))
    if (!description) throw new HostError('SKILL_INVALID', 'O SKILL.md precisa declarar uma description no cabeçalho')
    if (new Set(files.map((file) => file.path)).size !== files.length) throw new HostError('SKILL_INVALID', 'A skill repete um caminho de arquivo')
    if (!current.skills.some((s) => s.name === name) && current.skills.length >= 32) throw new HostError('LIMIT', 'Este bot já tem o máximo de skills')
    const directory = this.skillPath(current.botId, name)
    await rm(directory, { recursive: true, force: true })
    await privateDirectory(join(this.root(current.botId), 'skills'))
    for (const file of files) {
      const target = join(directory, file.path)
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
      await writePrivate(target, file.data.toString('binary'))
    }
    const previous = current.skills.find((s) => s.name === name)
    const summary: SkillSummary = {
      name,
      description: description.slice(0, 400),
      digest: skillDigest(files),
      bytes,
      files: files.length,
      enabled: previous?.enabled ?? true,
      revision: (previous?.revision ?? -1) + 1,
    }
    return this.repo.store.transaction(() => {
      this.repo.saveSkill(current.botId, summary)
      return this.bump(current)
    })
  }
  private async removeSkill(current: ExtensionsState, name: string): Promise<ExtensionsState> {
    await rm(this.skillPath(current.botId, name), { recursive: true, force: true })
    return this.repo.store.transaction(() => {
      this.repo.deleteSkill(current.botId, name)
      return this.bump(current)
    })
  }
  private setSkillEnabled(current: ExtensionsState, name: string, enabled: boolean): ExtensionsState {
    const skill = current.skills.find((s) => s.name === name)
    if (!skill) throw new HostError('SKILL_NOT_FOUND', 'Esta skill não está instalada neste bot')
    return this.repo.store.transaction(() => {
      this.repo.saveSkill(current.botId, { ...skill, enabled, revision: skill.revision + 1 })
      return this.bump(current)
    })
  }
  private commit(current: ExtensionsState, mcpServers: McpServer[]): ExtensionsState {
    return this.repo.store.transaction(() => {
      this.repo.saveServers(current.botId, current.revision + 1, mcpServers)
      return this.repo.state(current.botId)
    })
  }
  private bump(current: ExtensionsState): ExtensionsState {
    this.repo.saveServers(current.botId, current.revision + 1, current.mcpServers)
    return this.repo.state(current.botId)
  }

  private async readSecrets(botId: string, serverId: string): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readPrivate(this.secretPath(botId, serverId), 128 * 1024)) as Record<string, string>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  /** Reads a skill back from the state directory, refusing anything that is not a plain file inside it. */
  private async readSkill(botId: string, name: string): Promise<{ path: string; dataBase64: string }[]> {
    const root = this.skillPath(botId, name)
    const out: { path: string; dataBase64: string }[] = []
    const walk = async (relative: string) => {
      for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        const info = await lstat(join(root, rel))
        if (info.isSymbolicLink()) throw new HostError('SKILL_INVALID', `A skill ${name} contém um link, o que não é permitido`)
        if (entry.isDirectory()) await walk(rel)
        else if (info.isFile()) out.push({ path: rel, dataBase64: (await readFile(join(root, rel))).toString('base64') })
      }
    }
    await walk('')
    return out
  }

  /** Everything the guest needs, with the secrets, for the enabled servers and skills. Built per turn and never stored. */
  async payload(botId: string): Promise<ExtensionsApply | undefined> {
    if (!this.repo.exists(botId)) return undefined
    const state = this.repo.state(botId)
    const mcpServers: ExtensionsApply['mcpServers'] = []
    for (const server of state.mcpServers) {
      if (!server.enabled) continue
      mcpServers.push({ ...server, env: await this.readSecrets(botId, server.id) })
    }
    const skills: ExtensionsApply['skills'] = []
    for (const skill of state.skills) {
      if (!skill.enabled) continue
      skills.push({ name: skill.name, files: await this.readSkill(botId, skill.name) })
    }
    return { revision: state.revision, mcpServers, skills }
  }
  /** True when the bot has anything that would need the guest to change. */
  hasEnabled(botId: string): boolean {
    if (!this.repo.exists(botId)) return false
    const state = this.repo.state(botId)
    return state.mcpServers.some((s) => s.enabled) || state.skills.some((s) => s.enabled)
  }
}
