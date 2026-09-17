import type { DatabaseSync } from 'node:sqlite'
import { mcpServerSchema, skillSummarySchema, type ExtensionsState, type McpServer, type SkillSummary } from '@maestrly/host-protocol'
import { z } from 'zod'
import type { HostStore } from '../persistence/store.js'

const bodySchema = z.strictObject({ mcpServers: z.array(mcpServerSchema) })

/**
 * Durable configuration of a bot's extensions. Only configuration: secret values are files
 * outside SQLite (see extensions-service), skill contents are files too. One revision covers
 * servers and skills together, so a stale application can never overwrite what it did not see.
 */
export class ExtensionsRepository {
  readonly db: DatabaseSync
  constructor(readonly store: HostStore) {
    this.db = store.db
  }
  exists(botId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bot_extensions WHERE bot_id=?').get(botId)
  }
  state(botId: string): ExtensionsState {
    const row = this.db.prepare('SELECT revision, body FROM bot_extensions WHERE bot_id=?').get(botId) as { revision: number; body: string } | undefined
    const mcpServers = row ? bodySchema.parse(JSON.parse(row.body)).mcpServers : []
    const skills = (this.db.prepare('SELECT body FROM bot_skills WHERE bot_id=? ORDER BY name').all(botId) as { body: string }[]).map((r) =>
      skillSummarySchema.parse(JSON.parse(r.body))
    )
    return { botId, revision: row?.revision ?? 0, mcpServers, skills }
  }
  saveServers(botId: string, revision: number, mcpServers: McpServer[]) {
    this.db
      .prepare('INSERT INTO bot_extensions(bot_id,revision,body) VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,body=excluded.body')
      .run(botId, revision, JSON.stringify({ mcpServers }))
  }
  saveSkill(botId: string, skill: SkillSummary) {
    skillSummarySchema.parse(skill)
    this.db
      .prepare('INSERT INTO bot_skills(bot_id,name,digest,enabled,revision,body) VALUES(?,?,?,?,?,?) ON CONFLICT(bot_id,name) DO UPDATE SET digest=excluded.digest,enabled=excluded.enabled,revision=excluded.revision,body=excluded.body')
      .run(botId, skill.name, skill.digest, skill.enabled ? 1 : 0, skill.revision, JSON.stringify(skill))
  }
  deleteSkill(botId: string, name: string) {
    this.db.prepare('DELETE FROM bot_skills WHERE bot_id=? AND name=?').run(botId, name)
  }
}
