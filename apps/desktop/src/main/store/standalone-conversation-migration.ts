import type { DatabaseSync } from 'node:sqlite'

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`

export const conversationScopeConstraint = `CONSTRAINT conversation_scope_discriminant CHECK (
  scope IS NOT NULL AND (
    (scope = 'project' AND workspace_id IS NOT NULL AND branch IS NOT NULL
      AND mode IS NOT NULL AND mode IN ('worktree', 'local'))
    OR (scope = 'standalone' AND workspace_id IS NULL AND branch IS NULL AND mode IS NULL
      AND experience IS NOT NULL AND experience = 'standard' AND is_multi IS NOT NULL AND is_multi = 0)
  )
)`

/** Split column definitions without losing legacy defaults, constraints, or generated columns. */
function definitions(sql: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quoted = ''
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    if (quoted) {
      if (char === quoted) {
        if (sql[i + 1] === quoted) i++
        else quoted = ''
      }
    } else if ('\'"`['.includes(char)) quoted = char === '[' ? ']' : char
    else if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === ',' && depth === 0) {
      parts.push(sql.slice(start, i))
      start = i + 1
    }
  }
  parts.push(sql.slice(start))
  return parts
}

/** Run only after the existing normalization transaction commits, with no surrounding transaction. */
export function migrateStandaloneConversations(db: DatabaseSync): void {
  try {
    migrate(db)
  } finally {
    restoreForeignKeys(db)
  }
}

function restoreForeignKeys(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON')
  if ((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys !== 1) {
    throw new Error(
      'Standalone conversation migration could not restore foreign key enforcement; close the connection.'
    )
  }
}

function migrate(db: DatabaseSync): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'").get() as
    | { sql: string }
    | undefined
  if (!table) return
  const start = table.sql.indexOf('(')
  const end = table.sql.lastIndexOf(')')
  const columns = db.prepare('PRAGMA table_xinfo(conversations)').all() as Array<{
    name: string
    hidden: number
    notnull: number
  }>
  const hasScope = columns.some((column) => column.name === 'scope')
  const parts = definitions(table.sql.slice(start + 1, end))
  const normalize = (sql: string): string => sql.trim().replace(/\s+/g, ' ')
  const required = ['workspace_id', 'branch', 'mode', 'experience', 'is_multi', 'cwd', 'id']
  if (start < 0 || end <= start || required.some((name) => !columns.some((c) => c.name === name && c.hidden === 0))) {
    throw new Error('Unexpected conversations schema; standalone migration was not applied.')
  }
  if (hasScope || table.sql.includes('conversation_scope_discriminant')) {
    const nullable = ['workspace_id', 'branch', 'mode']
    if (
      parts.some((part) => normalize(part) === normalize(conversationScopeConstraint)) &&
      nullable.every((name) => columns.some((c) => c.name === name && c.notnull === 0)) &&
      columns.some((c) => c.name === 'scope' && c.hidden === 0 && c.notnull === 1)
    )
      return
    throw new Error('Unexpected conversations scope schema; standalone migration was not applied.')
  }
  // Do not attempt textual rewrites of unfamiliar SQL comments or conflict clauses.
  if (/--|\/\*|NOT\s+NULL\s+ON\s+CONFLICT/i.test(table.sql)) {
    throw new Error('Unexpected conversations schema; standalone migration was not applied.')
  }
  const body = parts.map((definition) => {
    if (
      /^\s*(?:workspace_id|branch|mode|"workspace_id"|"branch"|"mode"|`workspace_id`|`branch`|`mode`|\[workspace_id\]|\[branch\]|\[mode\])\s/i.test(
        definition
      )
    ) {
      // Mask quoted tokens so defaults such as 'NOT NULL' survive byte-for-byte.
      const unquoted = definition.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g, (token) =>
        ' '.repeat(token.length)
      )
      const constraint = /\bNOT\s+NULL\b/i.exec(unquoted)
      return constraint
        ? definition.slice(0, constraint.index) + definition.slice(constraint.index + constraint[0].length)
        : definition
    }
    return definition
  })
  // Columns must precede table constraints (legacy schemas may end in CHECK/UNIQUE/FK).
  if (!hasScope) body.unshift("scope TEXT NOT NULL DEFAULT 'project'")
  body.push(conversationScopeConstraint)
  // All views/triggers are restored: indirect dependencies may reference views of this table.
  const objects = db
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND
    (type IN ('view','trigger') OR (type='index' AND tbl_name='conversations'))
    ORDER BY CASE type WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid`)
    .all() as Array<{ type: string; name: string; sql: string }>
  db.exec('PRAGMA foreign_keys = OFF')
  if ((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys !== 0) {
    throw new Error('Standalone conversation migration requires no active transaction.')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const object of objects) if (object.type !== 'index') db.exec(`DROP ${object.type} ${quote(object.name)}`)
    db.exec(`CREATE TABLE conversations_standalone_new (${body.join(',')})${table.sql.slice(end + 1)}`)
    const names = columns
      .filter((column) => column.hidden === 0)
      .map((column) => quote(column.name))
      .join(',')
    db.exec(`INSERT INTO conversations_standalone_new (${names}) SELECT ${names} FROM conversations`)
    db.exec('DROP TABLE conversations')
    db.exec('ALTER TABLE conversations_standalone_new RENAME TO conversations')
    for (const object of objects) db.exec(object.sql)
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Standalone conversation migration foreign key check failed.')
    const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
      throw new Error('Standalone conversation migration integrity check failed.')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
