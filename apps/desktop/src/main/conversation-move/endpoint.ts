import type {
  ExportedPackage,
  ImportedConversation,
  ImportTargetInput,
  MoveDigest,
  MoveEndpointMethod,
  MoveEndpointProgress,
  MoveTargetWorkspacePlan,
  SourceInspection,
  TargetInspection,
  TargetInspectionInput,
} from '../../shared/conversation-move'
import { LOCAL_HOST_ID, type HostId } from '../../shared/host-key'
import { projectSetupService } from '../project-setup/service'
import {
  checkSourceAncestry,
  exportSource,
  freezeSource,
  inspectSource,
  releaseSource,
  type SourceDeps,
  thawSource,
} from './source'
import { moveStagingDirectory } from './staging'
import {
  cleanupMove,
  commitTarget,
  discardTarget,
  importTarget,
  inspectTarget,
  prepareTargetWorkspace,
  type TargetDeps,
  verifyTarget,
} from './target'

/** One host's part in a move, the same whether this computer calls it directly or over a host's bridge. */
export interface MoveEndpoint {
  readonly hostId: HostId
  inspectSource(input: { conversationId: string }): Promise<SourceInspection>
  checkAncestry(input: { conversationId: string; ancestorOid: string }): Promise<boolean>
  inspectTarget(input: TargetInspectionInput): Promise<TargetInspection>
  freezeSource(input: { operationId: string; conversationId: string; fingerprint: string }): Promise<void>
  exportSource(input: {
    operationId: string
    selectedIgnoredPaths: string[]
    confirmedSensitivePaths: string[]
  }): Promise<ExportedPackage>
  stagingDirectory(input: { operationId: string }): Promise<string>
  prepareTargetWorkspace(input: {
    operationId: string
    conversationId: string
    workspace: MoveTargetWorkspacePlan
  }): Promise<{ workspaceId: string }>
  importTarget(input: ImportTargetInput): Promise<ImportedConversation>
  verifyTarget(input: { operationId: string }): Promise<MoveDigest>
  releaseSource(input: { operationId: string }): Promise<void>
  commitTarget(input: { operationId: string }): Promise<void>
  discardTarget(input: { operationId: string }): Promise<void>
  thawSource(input: { operationId: string }): Promise<void>
  cleanup(input: { operationId: string }): Promise<void>
  /** Follows the clone and import progress of one move; returns its removal. */
  onProgress(operationId: string, listener: (progress: MoveEndpointProgress) => void): () => void
}

export const MOVE_ENDPOINT_METHODS = [
  'inspectSource',
  'checkAncestry',
  'inspectTarget',
  'freezeSource',
  'exportSource',
  'stagingDirectory',
  'prepareTargetWorkspace',
  'importTarget',
  'verifyTarget',
  'releaseSource',
  'commitTarget',
  'discardTarget',
  'thawSource',
  'cleanup',
] as const satisfies readonly MoveEndpointMethod[]

/** `inspectSource` → `conversation-move-endpoint:inspect-source`. */
export const moveEndpointChannel = (method: MoveEndpointMethod): string =>
  `conversation-move-endpoint:${method.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
export const MOVE_ENDPOINT_PROGRESS = 'conversation-move-endpoint:progress'

export function createLocalMoveEndpoint(deps: {
  appVersion: () => string
  setup?: TargetDeps['setup']
  quiesce?: SourceDeps['quiesce']
}): MoveEndpoint {
  const listeners = new Map<string, Set<(progress: MoveEndpointProgress) => void>>()
  const emit = (progress: MoveEndpointProgress): void => {
    for (const listener of listeners.get(progress.operationId) ?? []) listener(progress)
  }
  const sourceDeps: SourceDeps = {
    appVersion: deps.appVersion,
    // Loaded on first use: stopping a conversation reaches the whole chat runtime.
    quiesce:
      deps.quiesce ??
      (async (conversationId, cwd) =>
        (await import('../conversation-migration/quiesce')).quiesceConversation(conversationId, cwd)),
  }
  const targetDeps: TargetDeps = {
    appVersion: deps.appVersion,
    setup: deps.setup ?? projectSetupService,
    onProgress: emit,
  }
  return {
    hostId: LOCAL_HOST_ID,
    inspectSource,
    checkAncestry: checkSourceAncestry,
    inspectTarget,
    freezeSource: (input) => freezeSource(input, sourceDeps),
    exportSource: (input) => exportSource(input, sourceDeps),
    stagingDirectory: ({ operationId }) => moveStagingDirectory(operationId),
    prepareTargetWorkspace: (input) => prepareTargetWorkspace(input, targetDeps),
    importTarget: (input) => importTarget(input, targetDeps),
    verifyTarget,
    releaseSource,
    commitTarget,
    discardTarget,
    thawSource,
    cleanup: cleanupMove,
    onProgress(operationId, listener) {
      const set = listeners.get(operationId) ?? new Set()
      set.add(listener)
      listeners.set(operationId, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(operationId)
      }
    },
  }
}
