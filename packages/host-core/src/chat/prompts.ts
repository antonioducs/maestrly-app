import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { botPromptSchema, promptResultSchemas, type BotPrompt, type PromptMethod, type PromptRequest, type PromptResult } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { HostStore } from '../persistence/store.js'
import type { BotRepository } from '../bots/repository.js'

const now = () => new Date().toISOString()
const parseRow = (row: unknown): BotPrompt => botPromptSchema.parse(JSON.parse((row as { body: string }).body))

export class PromptRepository {
  readonly db: DatabaseSync
  constructor(readonly store: HostStore) {
    this.db = store.db
  }
  list(scope?: 'host' | 'bot', botId?: string): BotPrompt[] {
    const rows =
      scope === 'host'
        ? this.db.prepare("SELECT body FROM bot_prompts WHERE scope='host' ORDER BY name").all()
        : scope === 'bot'
          ? this.db.prepare("SELECT body FROM bot_prompts WHERE scope='bot' AND bot_id=? ORDER BY name").all(botId ?? '')
          : botId
            ? this.db.prepare("SELECT body FROM bot_prompts WHERE scope='host' OR bot_id=? ORDER BY name, CASE scope WHEN 'host' THEN 0 ELSE 1 END").all(botId)
            : this.db.prepare("SELECT body FROM bot_prompts WHERE scope='host' ORDER BY name").all()
    return rows.map(parseRow)
  }
  get(id: string): BotPrompt {
    const row = this.db.prepare('SELECT body FROM bot_prompts WHERE id=?').get(id)
    if (!row) throw new HostError('PROMPT_NOT_FOUND', 'Este comando não existe mais')
    return parseRow(row)
  }
  save(prompt: BotPrompt) {
    botPromptSchema.parse(prompt)
    this.db
      .prepare('INSERT INTO bot_prompts(id,scope,bot_id,name,revision,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,body=excluded.body')
      .run(prompt.id, prompt.scope, prompt.botId ?? null, prompt.name, prompt.revision, JSON.stringify(prompt))
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM bot_prompts WHERE id=?').run(id)
  }
}

/**
 * Prompt templates a person keeps: shared by every bot of this Host or private to one bot. The
 * Host never expands them and never sends them to a guest; they are the person's own shorthand.
 */
export class PromptService {
  readonly repo: PromptRepository
  constructor(
    store: HostStore,
    private readonly bots: BotRepository
  ) {
    this.repo = new PromptRepository(store)
  }
  async handle<M extends PromptMethod>(request: Extract<PromptRequest, { method: M }>): Promise<PromptResult<M>> {
    const result = await this.dispatch(request as PromptRequest)
    return promptResultSchemas[request.method].parse(result) as PromptResult<M>
  }
  private dispatch(request: PromptRequest): unknown {
    const p = request.params as Record<string, unknown>
    switch (request.method) {
      case 'prompt.list': {
        if (p.botId) this.bots.bot(p.botId as string)
        return { prompts: this.repo.list(p.scope as 'host' | 'bot' | undefined, p.botId as string | undefined) }
      }
      case 'prompt.upsert':
        return this.upsert(p as { id?: string; scope: 'host' | 'bot'; botId?: string; name: string; description: string; template: string; expectedRevision?: number })
      case 'prompt.delete':
        return this.repo.store.transaction(() => {
          let existing: BotPrompt
          try {
            existing = this.repo.get(p.id as string)
          } catch {
            // Deleting what is already gone is not an error a person needs to see.
            return { deleted: true }
          }
          if (existing.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'Este comando mudou; recarregue antes de remover')
          this.repo.delete(existing.id)
          return { deleted: true }
        })
    }
  }
  private upsert(p: { id?: string; scope: 'host' | 'bot'; botId?: string; name: string; description: string; template: string; expectedRevision?: number }): BotPrompt {
    if (p.scope === 'bot') {
      if (!p.botId) throw new HostError('PROMPT_SCOPE_INVALID', 'Um comando de bot precisa nomear o bot')
      this.bots.bot(p.botId)
    }
    return this.repo.store.transaction(() => {
      if (p.id) {
        const existing = this.repo.get(p.id)
        if (existing.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'Este comando mudou; recarregue antes de editar')
        const updated: BotPrompt = { ...existing, name: p.name, description: p.description, template: p.template, revision: existing.revision + 1, updatedAt: now() }
        this.saveUnique(updated)
        return updated
      }
      const created: BotPrompt = {
        id: randomUUID(),
        scope: p.scope,
        ...(p.scope === 'bot' ? { botId: p.botId } : {}),
        name: p.name,
        description: p.description,
        template: p.template,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      }
      this.saveUnique(created)
      return created
    })
  }
  private saveUnique(prompt: BotPrompt) {
    try {
      this.repo.save(prompt)
    } catch (error) {
      if (/UNIQUE/i.test(String((error as Error).message))) throw new HostError('PROMPT_NAME_TAKEN', 'Já existe um comando com este nome neste escopo')
      throw error
    }
  }
}
