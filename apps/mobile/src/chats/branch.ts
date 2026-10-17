import type { MobileNewChatBranch } from '@maestrly/bot-fleet-protocol'

/** What the new chat screen holds while the branch of a workspace chat is chosen. */
export type BranchDraft = { mode: 'new' | 'existing'; name: string; base: string | null; existing: string | null }
export const EMPTY_BRANCH_DRAFT: BranchDraft = { mode: 'new', name: '', base: null, existing: null }

/** What git refuses in a branch name (see `git check-ref-format`), checked before the host is asked. */
export function validBranchName(name: string): boolean {
  if (!name || name.length > 300) return false
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//'))
    return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  return !name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
}

/**
 * The branch a new chat asks the host for: undefined lets the host name a new one from the default branch, null means
 * the choice is not complete yet.
 */
export function branchChoice(draft: BranchDraft): MobileNewChatBranch | undefined | null {
  if (draft.mode === 'existing') return draft.existing ? { kind: 'existing', name: draft.existing } : null
  const name = draft.name.trim()
  if (name && !validBranchName(name)) return null
  if (!name && !draft.base) return undefined
  return { kind: 'new', ...(name ? { name } : {}), ...(draft.base ? { base: draft.base } : {}) }
}
