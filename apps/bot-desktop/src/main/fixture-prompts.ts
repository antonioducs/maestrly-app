import { randomUUID } from 'node:crypto'
import { botPromptSchema, type BotPrompt } from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'

const now = () => new Date().toISOString()
const fail = (code: string, message: string) => new HostRequestError(message, code)

/** In-memory prompt templates for interface work, with the same refusals as the Host. */
export class FixturePrompts {
  prompts = new Map<string, BotPrompt>()
  request(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'prompt.list': {
        const all = [...this.prompts.values()]
        const scope = p.scope as string | undefined
        const botId = p.botId as string | undefined
        const list = scope === 'host' ? all.filter((x) => x.scope === 'host') : scope === 'bot' ? all.filter((x) => x.botId === botId) : all.filter((x) => x.scope === 'host' || x.botId === botId)
        return { prompts: list.sort((a, b) => a.name.localeCompare(b.name) || (a.scope === 'host' ? -1 : 1)) }
      }
      case 'prompt.upsert': {
        if (p.id) {
          const existing = this.prompts.get(String(p.id))
          if (!existing) throw fail('PROMPT_NOT_FOUND', 'Este comando não existe mais')
          if (existing.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'Este comando mudou; recarregue antes de editar')
          const updated = botPromptSchema.parse({ ...existing, name: p.name, description: p.description ?? '', template: p.template, revision: existing.revision + 1, updatedAt: now() })
          this.prompts.set(updated.id, updated)
          return updated
        }
        const taken = [...this.prompts.values()].some((x) => x.name === p.name && x.scope === p.scope && (x.scope === 'host' || x.botId === p.botId))
        if (taken) throw fail('PROMPT_NAME_TAKEN', 'Já existe um comando com este nome neste escopo')
        const created = botPromptSchema.parse({ id: randomUUID(), scope: p.scope, ...(p.scope === 'bot' ? { botId: p.botId } : {}), name: p.name, description: p.description ?? '', template: p.template, revision: 0, createdAt: now(), updatedAt: now() })
        this.prompts.set(created.id, created)
        return created
      }
      case 'prompt.delete': {
        const existing = this.prompts.get(String(p.id))
        if (!existing) return { deleted: true }
        if (existing.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'Este comando mudou; recarregue antes de remover')
        this.prompts.delete(existing.id)
        return { deleted: true }
      }
    }
    throw fail('INVALID_REQUEST', `Unsupported fixture method ${method}`)
  }
}
