import path from 'node:path'
import type { Conversation } from './store/conversations'
import { canonicalTarget, createRepositoryScope, isInside, RepositoryScopeError } from './repository-scope'
import { validateStandaloneConversationDirectory } from './standalone-conversation-service'

export interface ConversationFileScope {
  resolveBridgePath(relativePath: string): Promise<{ root: string; target: string; displayPath: string; repo?: string }>
}

/** File authority is independent of repository authority for standalone conversations. */
export async function createConversationFileScope(conversation: Conversation): Promise<ConversationFileScope> {
  if (conversation.scope !== 'standalone') {
    const scope = await createRepositoryScope(conversation)
    return {
      async resolveBridgePath(relativePath) {
        const resolved = await scope.resolveBridgePath(relativePath)
        const repo = resolved.repository.linkName
        return {
          root: resolved.repository.realWorktreePath,
          target: resolved.absolutePath,
          displayPath: (repo ? `${repo}/${resolved.relativePath}`.replace(/\/$/, '') : resolved.relativePath) || '.',
          ...(repo ? { repo } : {}),
        }
      },
    }
  }
  const root = await validateStandaloneConversationDirectory(conversation)
  return {
    async resolveBridgePath(relativePath) {
      await validateStandaloneConversationDirectory(conversation)
      if (relativePath.includes('\0') || path.isAbsolute(relativePath)) {
        throw new RepositoryScopeError('invalid_path', 'The path must be relative to the conversation files directory.')
      }
      const lexical = path.resolve(root, relativePath || '.')
      if (!isInside(root, lexical))
        throw new RepositoryScopeError('path_escape', 'Path is outside the conversation files directory.')
      const target = await canonicalTarget(root, lexical)
      if (!isInside(root, target))
        throw new RepositoryScopeError(
          'path_escape',
          'Path escapes the conversation files directory through a symlink.'
        )
      return { root, target, displayPath: path.relative(root, lexical) || '.' }
    },
  }
}
