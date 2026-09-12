import { app } from 'electron'
import { listAllConversations, listWorkspaces, getDb } from '../store'
import { readNotebookReadOnly, type ExportedNotePage } from '../notes/notes-service'
import { listChatMessages, toPublicChatMessages, toPublicChatUsage, type StoredChatUsage } from '../chat/chat-store'
import type { ChatUsage } from '../../shared/chat'
import type { LocalMemory } from '../../shared/memory'
import { listLocalMemories } from '../memory/local-memory-service'

import { exportOwnedAssets, safeAssetId, type ExportedAsset } from './export-assets'

export const EXPORT_SCHEMA_VERSION = 7

const SETTINGS_SECRET_PATTERNS = [
  'token',
  'secret',
  'session',
  'password',
  'publishable',
  'service_role',
  'bearer',
  'apikey',
  'api_key',
  'api-key',
  'credential',
  'jwt',
]

export function filterExportableSettings(entries: Array<{ key: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, value } of entries) {
    const k = key.toLowerCase()
    if (/^(license|auth|account|telemetry|cloud|sentry|crashReporting)[._-]/i.test(k)) continue
    if (SETTINGS_SECRET_PATTERNS.some((p) => k.includes(p))) continue
    out[key] = value
  }
  return out
}

export interface ExportedConversation {
  conversation: unknown
  messages: unknown[]

  notes: ExportedNotePage[] | null
}
export interface ExportedUsageHistory {
  messageId: string
  providerId: string
  modelId: string
  usage: ChatUsage
  createdAt: number
}
export interface ExportBundle {
  meta: {
    schemaVersion: number
    exportedAtIso: string
    appVersion: string
    note: string
  }

  workspaces: unknown[]
  conversations: ExportedConversation[]
  projectNotes: Array<{ workspaceId: string; notes: ExportedNotePage[] }>

  localMemories: Array<{ workspaceId: string; memories: LocalMemory[] }>

  settings: Record<string, string>

  usageHistory: ExportedUsageHistory[]

  assets: ExportedAsset[]
  omissions: string[]
}

function listUsageHistory(omissions: string[]): ExportedUsageHistory[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT message_id, provider_id, model_id, usage_json, created_at
         FROM chat_usage_ledger
         ORDER BY created_at ASC, message_id ASC`
      )
      .all() as Array<{
      message_id: string
      provider_id: string
      model_id: string
      usage_json: string
      created_at: number
    }>
    const out: ExportedUsageHistory[] = []
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.usage_json) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid usage record')
        const usage = toPublicChatUsage(parsed as StoredChatUsage)
        if (!usage) throw new Error('Invalid usage record')
        out.push({
          messageId: row.message_id,
          providerId: row.provider_id,
          modelId: row.model_id,
          usage,
          createdAt: row.created_at,
        })
      } catch {
        omissions.push(`Could not read usage record ${row.message_id}.`)
      }
    }
    return out
  } catch {
    omissions.push('Could not read usage history.')
    return []
  }
}

export async function buildExportBundle(): Promise<ExportBundle> {
  const omissions: string[] = []
  const workspaces = listWorkspaces()
  const conversations = listAllConversations()

  const exportedConversations: ExportedConversation[] = []
  for (const conv of conversations) {
    const messages = toPublicChatMessages(listChatMessages(conv.id))
    const notes = await readNotebookReadOnly('conv', conv.id).catch(() => {
      omissions.push(`Could not read notes for conversation ${conv.id}.`)
      return null
    })
    exportedConversations.push({ conversation: conv, messages, notes })
  }

  const projectNotes: Array<{ workspaceId: string; notes: ExportedNotePage[] }> = []
  for (const ws of workspaces) {
    const notes = await readNotebookReadOnly('project', ws.id).catch(() => {
      omissions.push(`Could not read notes for workspace ${ws.id}.`)
      return null
    })
    if (notes && notes.length > 0) projectNotes.push({ workspaceId: ws.id, notes })
  }

  const localMemories = workspaces.map((workspace) => {
    const memories: LocalMemory[] = []
    for (let offset = 0; ; offset += 500) {
      const page = listLocalMemories(workspace.id, { limit: 500, offset })
      memories.push(...page)
      if (page.length < 500) break
    }
    return { workspaceId: workspace.id, memories }
  })

  let settings: Record<string, string> = {}
  try {
    const rows = getDb().prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>
    settings = filterExportableSettings(rows)
  } catch {
    omissions.push('Could not read app settings.')
  }

  const assets = await exportOwnedAssets(omissions)
  for (const conv of exportedConversations) {
    const id = (conv.conversation as { id: string }).id
    for (const message of conv.messages) {
      for (const part of (message as { parts: Array<{ type: string; artifactId?: string }> }).parts) {
        if (!part.artifactId || !['generated-image', 'file'].includes(part.type)) continue
        const root = part.type === 'generated-image' ? 'chat-generated-images' : 'chat-attachment-images'
        const prefix = `${root}/${id}/${part.artifactId}.`
        if (
          !safeAssetId(id) ||
          !safeAssetId(part.artifactId) ||
          !assets.some((asset) => asset.path.startsWith(prefix))
        ) {
          omissions.push(`Could not export referenced ${part.type} asset ${part.artifactId} for conversation ${id}.`)
        }
      }
    }
  }
  for (const notebook of projectNotes) {
    for (const page of notebook.notes) {
      for (const match of page.content.matchAll(/assets\/([^)\s"'<>]+)/g)) {
        const relative = `workspace-data/${notebook.workspaceId}/project-notes/assets/${match[1]}`
        if (!assets.some((asset) => asset.path === relative))
          omissions.push(`Could not export referenced notebook asset ${relative}.`)
      }
    }
  }

  return {
    meta: {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAtIso: new Date().toISOString(),
      appVersion: app.getVersion(),
      note: 'Local Maestrly data export with app-owned asset bytes. Excludes search indexes, embeddings, credentials, and repository/worktree files (including conversation notebook assets). Not a full filesystem backup; inspect omissions before resetting.',
    },
    workspaces,
    conversations: exportedConversations,
    projectNotes,
    localMemories,
    settings,
    usageHistory: listUsageHistory(omissions),
    assets,
    omissions,
  }
}
