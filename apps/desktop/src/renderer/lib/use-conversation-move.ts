import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { i18n } from '@/lib/i18n'
import type { Conversation, MoveRecovery, MoveResult } from '../../preload'
import { type HostId, parseHostKey } from '../../shared/host-key'
import {
  dialogOperationId,
  initialMoveFlow,
  moveFlowReducer,
  moveTargetConversationKey,
} from '@/lib/conversation-move/flow'

type RecoveryAction = 'continue' | 'rollback'

interface Params {
  /** Lists a host's workspaces again, after a conversation left or reached it. */
  refreshHost: (hostId: HostId) => Promise<unknown>
  /** Shows the conversation with this window key once its host lists it. */
  focusConversationKey: (key: string) => void
}

function cleanIpcError(error: unknown): string {
  return String((error as { message?: string })?.message ?? error).replace(
    /^Error invoking remote method '[^']*':\s*(Error:\s*)?/,
    ''
  )
}

/** Moving conversations between this computer and its hosts: the dialog's flow and the moves left to recover. */
export function useConversationMove({ refreshHost, focusConversationKey }: Params) {
  const api = window.api
  const [state, dispatch] = useReducer(moveFlowReducer, initialMoveFlow)
  const stateRef = useRef(state)
  stateRef.current = state
  const [recoveries, setRecoveries] = useState<MoveRecovery[]>([])
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [resolving, setResolving] = useState<{ operationId: string; action: RecoveryAction } | null>(null)

  const reloadRecoveries = useCallback(async () => {
    try {
      setRecoveries(await api.listConversationMoveRecoveries())
      setRecoveryError(null)
    } catch (error) {
      setRecoveryError(cleanIpcError(error))
    }
  }, [api])

  useEffect(() => {
    void reloadRecoveries()
  }, [reloadRecoveries])

  /** Both hosts list their conversations again; a completed move shows the conversation where it now is. */
  const settle = useCallback(
    async (move: { sourceHostId: HostId; targetHostId: HostId; conversationId: string }, result: MoveResult) => {
      await Promise.allSettled([refreshHost(move.sourceHostId), refreshHost(move.targetHostId)])
      if (result.status === 'completed' && result.target)
        focusConversationKey(moveTargetConversationKey(result.target.hostId, result.target.conversationId))
      else if (result.status === 'rolled-back')
        focusConversationKey(moveTargetConversationKey(move.sourceHostId, move.conversationId))
    },
    [focusConversationKey, refreshHost]
  )

  useEffect(
    () =>
      api.onConversationMoveChanged((event) => {
        dispatch({ type: 'progress', event })
        if (event.operationId === dialogOperationId(stateRef.current)) return
        if (event.status === 'recovery-required' || event.status === 'completed' || event.status === 'rolled-back') {
          void reloadRecoveries()
          void Promise.allSettled([refreshHost(event.sourceHostId), refreshHost(event.targetHostId)])
        }
      }),
    [api, refreshHost, reloadRecoveries]
  )

  const prepare = useCallback(
    async (
      input: { sourceHostId: HostId; conversationId: string; targetHostId: HostId; conversationName: string },
      targetBranch?: string
    ) => {
      dispatch({ type: 'prepare', ...input })
      try {
        const preview = await api.prepareConversationMove({
          sourceHostId: input.sourceHostId,
          conversationId: input.conversationId,
          targetHostId: input.targetHostId,
          ...(targetBranch ? { targetBranch } : {}),
        })
        dispatch({ type: 'prepared', preview })
      } catch (error) {
        dispatch({ type: 'failed', message: cleanIpcError(error) })
      }
    },
    [api]
  )

  const open = useCallback(
    (conversation: Conversation, targetHostId: HostId) => {
      if (stateRef.current.kind !== 'idle') return
      const { hostId, id } = parseHostKey(conversation.id)
      void prepare({ sourceHostId: hostId, conversationId: id, targetHostId, conversationName: conversation.name })
    },
    [prepare]
  )

  const releasePrepared = useCallback(async () => {
    const current = stateRef.current
    if (current.kind === 'preview' && current.preview.operationId)
      await api.cancelConversationMove(current.preview.operationId).catch(() => undefined)
  }, [api])

  /** Prepares again with the branch name the person typed. */
  const applyBranch = useCallback(async () => {
    const current = stateRef.current
    if (current.kind !== 'preview') return
    const branch = current.branchDraft.trim()
    if (!branch) return
    const { preview } = current
    await releasePrepared()
    await prepare(
      {
        sourceHostId: preview.sourceHostId,
        conversationId: preview.conversationId,
        targetHostId: preview.targetHostId,
        conversationName: preview.conversationName,
      },
      branch
    )
  }, [prepare, releasePrepared])

  const finish = useCallback(
    async (preview: { sourceHostId: HostId; targetHostId: HostId; conversationId: string }, result: MoveResult) => {
      dispatch({ type: 'finished', result })
      await reloadRecoveries()
      if (result.status === 'completed' || result.status === 'rolled-back') await settle(preview, result)
    },
    [reloadRecoveries, settle]
  )

  const execute = useCallback(async () => {
    const current = stateRef.current
    if (current.kind !== 'preview' || !current.preview.operationId) return
    const { preview } = current
    dispatch({ type: 'execute' })
    try {
      const result = await api.executeConversationMove({
        operationId: preview.operationId!,
        selectedIgnoredPaths: current.selected,
        confirmedSensitivePaths: current.confirmed,
      })
      await finish(preview, result)
    } catch (error) {
      dispatch({ type: 'failed', message: cleanIpcError(error) })
      await reloadRecoveries()
    }
  }, [api, finish, reloadRecoveries])

  /** Continues or rolls back the move the dialog shows after it stopped. */
  const resolveInDialog = useCallback(
    async (action: RecoveryAction) => {
      const current = stateRef.current
      if (current.kind !== 'error' || !current.recovery || !current.preview) return
      if (action === 'rollback' && !window.confirm(i18n.t('ui:conversationMove.recovery.rollbackConfirm'))) return
      const { preview, recovery } = current
      dispatch({ type: 'execute' })
      try {
        await finish(preview, await api.resolveConversationMove(recovery.operationId, action))
      } catch (error) {
        dispatch({ type: 'failed', message: cleanIpcError(error) })
        await reloadRecoveries()
      }
    },
    [api, finish, reloadRecoveries]
  )

  const close = useCallback(async () => {
    const current = stateRef.current
    if (current.kind === 'executing' || current.kind === 'preparing') return
    await releasePrepared()
    dispatch({ type: 'close' })
    await reloadRecoveries()
  }, [releasePrepared, reloadRecoveries])

  const resolveRecovery = useCallback(
    async (recovery: MoveRecovery, action: RecoveryAction) => {
      if (action === 'rollback' && !window.confirm(i18n.t('ui:conversationMove.recovery.rollbackConfirm'))) return
      setResolving({ operationId: recovery.operationId, action })
      setRecoveryError(null)
      try {
        const result = await api.resolveConversationMove(recovery.operationId, action)
        await reloadRecoveries()
        await settle(recovery, result)
      } catch (error) {
        setRecoveryError(cleanIpcError(error))
        await reloadRecoveries()
      } finally {
        setResolving(null)
      }
    },
    [api, reloadRecoveries, settle]
  )

  // The dialog handles its own move; only moves stopped for recovery wait for the person here.
  const pendingRecoveries = useMemo(
    () =>
      recoveries.filter(
        (recovery) => recovery.status === 'recovery-required' && recovery.operationId !== dialogOperationId(state)
      ),
    [recoveries, state]
  )

  return {
    state,
    open,
    execute: () => void execute(),
    close: () => void close(),
    applyBranch: () => void applyBranch(),
    editBranch: (value: string) => dispatch({ type: 'edit-branch', value }),
    toggleIgnored: (path: string) => dispatch({ type: 'toggle-ignored', path }),
    confirmSensitive: (path: string) => dispatch({ type: 'confirm-sensitive', path }),
    resolveInDialog: (action: RecoveryAction) => void resolveInDialog(action),
    recoveries: pendingRecoveries,
    recoveryError,
    resolving,
    resolveRecovery: (recovery: MoveRecovery, action: RecoveryAction) => void resolveRecovery(recovery, action),
    retryRecoveries: () => void reloadRecoveries(),
  }
}
