import { publicCreateConversationSchema } from '../shared/local-conversation'
import type { ConversationExperience } from '../shared/conversation-experience'
import { getConversationBranchInfo } from './conversation-branch-service'
import { assertConversationMigrationMutationAllowed } from './conversation-migration/store'
import * as floatingManager from './floating-manager'
import * as popupManager from './popup-manager'
import { disposeConversation } from './drawer-manager'
import type { IpcRegistrar } from './ipc-registrar'
import { unwatchNotes } from './notes/notes-service'
import { clearPlan } from './plan-broker'
import { unwatchConversation } from './selection-bridge'
import {
  countOtherActiveConversationsInCwd,
  getConversation,
  listConversations,
  patchConvUiPrefs,
  setConversationOrder,
  setConversationPinned,
} from './store'
import { disposeShellTerminals } from './terminal-manager'
import { lookupReviewLoopByConversation } from './chat/review-loop/registry'
import {
  createConversation,
  createSiblingConversation,
  deleteConversation,
  renameConversation,
  setConversationArchived,
} from './workspace-service'

export interface ConversationIpcDeps {
  stopChat: (id: string) => void | Promise<void>
}

function assertReviewLoopMutationAllowed(conversationId: string): void {
  if (lookupReviewLoopByConversation(conversationId)) {
    throw new Error('The conversation is reserved by an active review loop.')
  }
}

export function registerConversationIpc(reg: IpcRegistrar, deps: ConversationIpcDeps): void {
  reg.mhandle('conversation:create', (_e, payload: unknown) => {
    const parsed = publicCreateConversationSchema.safeParse(payload)
    if (!parsed.success) throw new Error('Invalid payload for creating a worktree conversation.')
    if (parsed.data.repos && parsed.data.repos[0]?.workspaceId !== parsed.data.workspaceId) {
      throw new Error('The primary workspace must match the first repository.')
    }
    return createConversation(parsed.data)
  })
  // #322: Attach a sibling to the same worktree/branch of an unbound conversation. Renderer supplies only
  // sourceConversationId; main derives cwd/branch and validates eligibility without exposing raw attach.
  reg.mhandle(
    'conversation:createSibling',
    (_e, args: { sourceConversationId: string; experience?: ConversationExperience }) => {
      assertReviewLoopMutationAllowed(args.sourceConversationId)
      assertConversationMigrationMutationAllowed(args.sourceConversationId, 'Create sibling conversation')
      if (args.experience !== undefined && args.experience !== 'standard' && args.experience !== 'maestro') {
        throw new Error('Invalid conversation experience.')
      }
      return createSiblingConversation(args.sourceConversationId, { experience: args.experience })
    }
  )
  reg.handle('conversation:list', (_e, workspaceId: string) => listConversations(workspaceId))
  reg.handle('conversation:branch-info', (_e, id: string) => getConversationBranchInfo(id))
  reg.mhandle('conversation:rename', (_e, id: string, name: string) => {
    renameConversation(id, name)
    floatingManager.refreshFloatingTitles() // floating strip/title shows the conversation name
  })
  // Main drawer tab order persists per conversation in ui_prefs.
  reg.mon('conv:set-main-tab-order', (_e, id: string, order: string[]) => patchConvUiPrefs(id, { mainTabOrder: order }))
  reg.mhandle('conversation:reorder', (_e, workspaceId: string, ids: string[]) =>
    setConversationOrder(workspaceId, ids)
  )
  // Pin/unpin returns the canonical timestamp or null so UI can update without refresh. Store requires a
  // regular, unarchived conversation.
  reg.mhandle('conversation:pin', (_e, id: string, pinned: boolean) => setConversationPinned(id, pinned))
  reg.mhandle('conversation:archive', async (_e, id: string, archived: boolean) => {
    assertReviewLoopMutationAllowed(id)
    assertConversationMigrationMutationAllowed(id, archived ? 'Archive conversation' : 'Unarchive conversation')
    if (archived) {
      // Stop streams and invalidate late callbacks before destroying views. stopChat retires active
      // official sessions; preserve completed sessions because archive is reversible.
      clearPlan(id)
      await deps.stopChat(id)
      disposeShellTerminals(id)
      floatingManager.disposeConversation(id) // close floating windows before destroying views
      popupManager.disposeConversation(id) // clear popup state before destroying views (#328)
      disposeConversation(id)
      cleanupSharedWatchers(id) // #322: release shared watchers only when no active sibling needs them
    }
    setConversationArchived(id, archived)
  })
  reg.mhandle('conversation:delete', async (_e, id: string) => {
    assertReviewLoopMutationAllowed(id)
    assertConversationMigrationMutationAllowed(id, 'Delete conversation')
    // Permanent deletion stops the agent and drawer terminals, releases views, and removes worktree/store
    // state.
    clearPlan(id)
    await deps.stopChat(id)
    disposeShellTerminals(id)
    floatingManager.disposeConversation(id) // close floating windows before destroying views
    popupManager.disposeConversation(id) // clear popup state before destroying views (#328)
    disposeConversation(id)
    cleanupSharedWatchers(id) // before deleting the row needed to resolve notes paths and cwd
    // Persistent cleanup lives in the service and also covers workspace removal.
    await deleteConversation(id)
  })
}

/**
 * Reference-count watcher cleanup before conversation deletion while its row still exists. Always
 * unwatch selection for this sibling; selection-bridge closes a cwd watcher only after the last
 * registered sibling leaves. Shared notes are unwatched only when no other active conversation uses
 * the cwd. Count active siblings, excluding archived ones, so archiving the last active sibling
 * releases the watcher (#322).
 */
function cleanupSharedWatchers(id: string): void {
  const conv = getConversation(id)
  if (!conv) {
    void unwatchNotes(id)
    return
  }
  if (countOtherActiveConversationsInCwd(conv.cwd, id) === 0) void unwatchNotes(id)
  unwatchConversation(id, conv.cwd)
}
