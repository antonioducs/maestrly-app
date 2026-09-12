export const MEMORY_TYPES = ['decision', 'constraint', 'preference', 'procedure', 'lesson', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const LOCAL_MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const
export type LocalMemoryStatus = (typeof LOCAL_MEMORY_STATUSES)[number]

export const LOCAL_MEMORY_SOURCES = ['user', 'agent', 'legacy-import'] as const
export type LocalMemorySource = (typeof LOCAL_MEMORY_SOURCES)[number]

export const SHARED_MEMORY_TYPES = ['decision', 'constraint', 'procedure', 'lesson', 'reference'] as const
export type SharedMemoryType = (typeof SHARED_MEMORY_TYPES)[number]

export const SHARED_MEMORY_STATUSES = ['active', 'superseded', 'deprecated', 'historical'] as const
export type SharedMemoryStatus = (typeof SHARED_MEMORY_STATUSES)[number]

export interface LocalMemory {
  id: string
  workspaceId: string
  title: string
  content: string
  type: MemoryType
  status: LocalMemoryStatus
  scope: string
  tags: string[]
  importance: number
  pinned: boolean
  source: LocalMemorySource
  originConversationId?: string
  originMessageId?: string
  supersedesId?: string
  promotedPath?: string
  contentHash: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  useCount: number
}

export interface LocalMemoryCreateInput {
  id?: string
  workspaceId: string
  title: string
  content: string
  type: MemoryType
  scope?: string
  tags?: string[]
  importance?: number
  pinned?: boolean
  source: LocalMemorySource
  originConversationId?: string
  originMessageId?: string
  supersedesId?: string
}

export interface LocalMemoryUpdateInput {
  title?: string
  content?: string
  type?: MemoryType
  status?: LocalMemoryStatus
  scope?: string
  tags?: string[]
  importance?: number
  pinned?: boolean
  supersedesId?: string | null
  promotedPath?: string | null
}

export interface LocalMemoryFilters {
  status?: LocalMemoryStatus | LocalMemoryStatus[]
  type?: MemoryType | MemoryType[]
  tag?: string
  scope?: string
  source?: LocalMemorySource | LocalMemorySource[]
  pinned?: boolean
  query?: string
  updatedAfter?: number
  limit?: number
  offset?: number
}

export interface LocalMemoryMutationResult {
  memory: LocalMemory
  duplicate: boolean
  changed: boolean
}

export interface SharedMemoryProvenance {
  repo: string
  path: string
  heading?: string
  startLine?: number
  endLine?: number
}

export interface SharedKnowledgeDocument {
  id: string
  root: string
  relativePath: string
  title: string
  content: string
  type: SharedMemoryType
  status: SharedMemoryStatus
  scope: string
  tags: string[]
  supersedes: string[]
  alwaysApply: boolean
  contentHash: string
  modifiedAt: number
  provenance: SharedMemoryProvenance
  warnings: string[]
  eligibleForContext: boolean
}

export interface MemorySourceRef {
  kind: 'local' | 'shared'
  id: string
  title: string
  repo?: string
  path?: string
  heading?: string
  startLine?: number
  endLine?: number
}

export interface MemorySearchHit extends MemorySourceRef {
  content: string
  type: MemoryType | SharedMemoryType
  status: LocalMemoryStatus | SharedMemoryStatus
  scope: string
  tags: string[]
  score: number
  pinned?: boolean
  alwaysApply?: boolean
  source?: LocalMemorySource
  updatedAt?: number
  lastUsedAt?: number
  useCount?: number
}

export type MemoryIndexState = 'ready' | 'indexing' | 'text-only' | 'disabled' | 'error'

export interface MemoryIndexStatus {
  workspaceId: string
  state: MemoryIndexState
  documents: number
  chunks: number
  localDocuments: number
  sharedDocuments: number
  semanticAvailable: boolean
  pendingEmbeddings: number
  lastReconciledAt?: number
  errorCode?: string
}

export interface MemoryChangeEvent {
  workspaceId: string
  kind: 'created' | 'updated' | 'archived' | 'restored' | 'forgotten' | 'promoted' | 'enabled-changed'
  memoryId?: string
}

export interface MemoryContextMeta {
  /** Legacy automatic-retrieval metadata retained for persisted conversation compatibility. */
  revision: string
  sources: MemorySourceRef[]
  degradedReason?: string
}

export interface MemoryPromotionPreviewInput {
  workspaceId: string
  memoryId: string
  type?: SharedMemoryType
  scope?: string
  slug?: string
}

export interface MemoryPromotionInput extends MemoryPromotionPreviewInput {
  repositoryRoot?: string
  overwrite?: boolean
}
