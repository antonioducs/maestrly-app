import { getDb } from './store/db'

/** A conditional write prevents a delayed first turn from replacing a manual name. */
export function nameStandaloneConversationFromText(conversationId: string, text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (!normalized) return false
  const characters = Array.from(normalized)
  const name = characters.length > 64 ? `${characters.slice(0, 63).join('')}…` : normalized
  return (
    getDb()
      .prepare(`UPDATE conversations SET name = ?,
    ui_prefs = json_set(ui_prefs, '$.autoName', json('false'))
    WHERE id = ? AND scope = 'standalone'
      AND json_extract(CASE WHEN json_valid(ui_prefs) THEN ui_prefs ELSE '{}' END, '$.autoName') = 1`)
      .run(name, conversationId).changes === 1
  )
}
