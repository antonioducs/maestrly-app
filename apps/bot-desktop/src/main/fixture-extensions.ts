import { createHash, randomUUID } from 'node:crypto'
import { SKILL_MAX_BYTES, SKILL_MAX_FILES, extensionsStateSchema, type ExtensionsState, type McpServer, type SkillSummary } from '@maestrly/host-protocol'
import { skillDescriptionOf } from './extension-client'
import { HostRequestError } from './host-client'

const fail = (code: string, message: string) => new HostRequestError(message, code)

/** In-memory per-bot extensions for interface work, with the same refusals as the Host. Secrets are kept only to derive `envKeys`. */
export class FixtureExtensions {
  private states = new Map<string, ExtensionsState>()
  private secrets = new Map<string, Record<string, string>>()
  private state(botId: string): ExtensionsState {
    return this.states.get(botId) ?? { botId, revision: 0, mcpServers: [], skills: [] }
  }
  private commit(next: ExtensionsState): ExtensionsState {
    const state = extensionsStateSchema.parse({ ...next, revision: next.revision + 1 })
    this.states.set(state.botId, state)
    return state
  }
  request(method: string, p: Record<string, unknown>): unknown {
    const botId = String(p.botId)
    const current = this.state(botId)
    if (method === 'extension.inspect') return current
    if (current.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'As extensões deste bot mudaram; recarregue antes de editar')
    switch (method) {
      case 'extension.mcp.upsert': {
        const input = p.server as McpServer & { env?: Record<string, string> }
        const existing = current.mcpServers.find((s) => s.id === input.id)
        if (!existing && current.mcpServers.some((s) => s.name === input.name)) throw fail('MCP_NAME_TAKEN', 'Já existe um servidor com este nome neste bot')
        const id = existing?.id ?? randomUUID()
        const stored = { ...(this.secrets.get(id) ?? {}) }
        for (const [key, value] of Object.entries(input.env ?? {})) {
          if (value === '') delete stored[key]
          else stored[key] = value
        }
        this.secrets.set(id, stored)
        const { env: _env, ...server } = input
        const saved: McpServer = { ...server, id, args: server.args ?? [], enabled: server.enabled ?? true, envKeys: Object.keys(stored).sort() }
        return this.commit({ ...current, mcpServers: existing ? current.mcpServers.map((s) => (s.id === id ? saved : s)) : [...current.mcpServers, saved] })
      }
      case 'extension.mcp.remove':
        this.secrets.delete(String(p.serverId))
        return this.commit({ ...current, mcpServers: current.mcpServers.filter((s) => s.id !== p.serverId) })
      case 'extension.skill.install': {
        const files = (p.files as { path: string; dataBase64: string }[]).map((file) => ({ path: file.path, data: Buffer.from(file.dataBase64, 'base64') }))
        if (files.length > SKILL_MAX_FILES) throw fail('SKILL_TOO_LARGE', `Uma skill tem no máximo ${SKILL_MAX_FILES} arquivos`)
        const bytes = files.reduce((sum, file) => sum + file.data.length, 0)
        if (bytes > SKILL_MAX_BYTES) throw fail('SKILL_TOO_LARGE', 'Esta skill passa do tamanho máximo permitido')
        const manifest = files.find((file) => file.path === 'SKILL.md')
        const description = manifest && skillDescriptionOf(manifest.data.toString('utf8'))
        if (!manifest) throw fail('SKILL_INVALID', 'Uma skill precisa de um SKILL.md na raiz')
        if (!description) throw fail('SKILL_INVALID', 'O SKILL.md precisa declarar uma description no cabeçalho')
        const hash = createHash('sha256')
        for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(file.path).update('\0').update(file.data).update('\0')
        const previous = current.skills.find((s) => s.name === p.name)
        const summary: SkillSummary = { name: String(p.name), description: description.slice(0, 400), digest: hash.digest('hex'), bytes, files: files.length, enabled: previous?.enabled ?? true, revision: (previous?.revision ?? -1) + 1 }
        return this.commit({ ...current, skills: [...current.skills.filter((s) => s.name !== p.name), summary].sort((a, b) => a.name.localeCompare(b.name)) })
      }
      case 'extension.skill.remove':
        return this.commit({ ...current, skills: current.skills.filter((s) => s.name !== p.name) })
      case 'extension.skill.setEnabled': {
        const skill = current.skills.find((s) => s.name === p.name)
        if (!skill) throw fail('SKILL_NOT_FOUND', 'Esta skill não está instalada neste bot')
        return this.commit({ ...current, skills: current.skills.map((s) => (s.name === p.name ? { ...s, enabled: p.enabled as boolean, revision: s.revision + 1 } : s)) })
      }
    }
    throw fail('INVALID_REQUEST', `Unsupported fixture method ${method}`)
  }
}
