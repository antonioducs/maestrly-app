import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { i18n } from '@/lib/i18n'
import type {
  Conversation,
  MigrationChangedEvent,
  MigrationRecovery,
  MigrationResult,
  WorkspaceWithConversations,
} from '../../preload'
import {
  conversationMigrationDialogReducer,
  findConversation,
  initialConversationMigrationDialog,
} from '@/components/conversation-migration/flow'

type RecoveryAction = 'continue' | 'rollback'

interface Params {
  active: Conversation | null
  refreshWorkspaces: (includeArchived?: boolean) => Promise<WorkspaceWithConversations[]>
  focusConversation: (conversation: Conversation) => void
}

function cleanIpcError(error: unknown): string {
  return String((error as { message?: string })?.message ?? error).replace(
    /^Error invoking remote method '[^']*':\s*(Error:\s*)?/,
    ''
  )
}

export function useConversationMigration({ active, refreshWorkspaces, focusConversation }: Params) {
  const [dialog, dispatchDialog] = useReducer(conversationMigrationDialogReducer, initialConversationMigrationDialog)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const [recoveries, setRecoveries] = useState<MigrationRecovery[] | null>(null)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [resolvingRecovery, setResolvingRecovery] = useState<{
    operationId: string
    action: RecoveryAction
  } | null>(null)
  const resolvingRef = useRef(new Set<string>())
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  const reloadRecoveries = useCallback(async () => {
    try {
      const current = await window.api.listConversationMigrationRecoveries()
      setRecoveryError(null)
      setRecoveries(current)
      return current
    } catch (error) {
      setRecoveryError(cleanIpcError(error))
      setRecoveries([])
      return []
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api
      .listConversationMigrationRecoveries()
      .then((current) => {
        if (!cancelled) setRecoveries(current)
      })
      .catch((error) => {
        if (!cancelled) {
          setRecoveryError(cleanIpcError(error))
          setRecoveries([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const focusById = useCallback(
    async (conversationId: string, options: { cancelIfActiveChanges?: boolean } = {}): Promise<boolean> => {
      const initialActiveId = activeRef.current?.id ?? null
      const selectionIsCurrent = () =>
        !options.cancelIfActiveChanges || (activeRef.current?.id ?? null) === initialActiveId
      setNavigationError(null)
      try {
        const refreshed = await refreshWorkspaces()
        if (!selectionIsCurrent()) return false
        const conversation = findConversation(refreshed, conversationId)
        if (conversation) {
          focusConversation(conversation)
          return true
        }
        setNavigationError(i18n.t('ui:conversationMigration.conversationNotFound'))
        return false
      } catch (error) {
        if (selectionIsCurrent()) setNavigationError(cleanIpcError(error))
        return false
      }
    },
    [refreshWorkspaces, focusConversation]
  )

  const reconcileTerminalEvent = useCallback(
    async (event: MigrationChangedEvent) => {
      const initialActiveId = activeRef.current?.id ?? null
      const [, refreshed] = await Promise.all([reloadRecoveries(), refreshWorkspaces()])
      if ((activeRef.current?.id ?? null) !== initialActiveId) return
      const targetId = event.status === 'rolled-back' ? event.conversationId : initialActiveId
      const refreshedActive = targetId ? findConversation(refreshed, targetId) : null
      if (refreshedActive) focusConversation(refreshedActive)
    },
    [focusConversation, reloadRecoveries, refreshWorkspaces]
  )

  useEffect(
    () =>
      window.api.onConversationMigrationChanged((event) => {
        const currentDialog = dialogRef.current
        const dialogOperationId = currentDialog.preview?.operationId
        dispatchDialog({ type: 'progress', event })
        if (currentDialog.open && dialogOperationId === event.operationId) return
        if (
          event.status === 'completed' ||
          event.status === 'rolled-back' ||
          event.status === 'cancelled' ||
          event.status === 'recovery-required'
        ) {
          void reconcileTerminalEvent(event).catch((error) => {
            setNavigationError(cleanIpcError(error))
          })
        }
      }),
    [focusById, reconcileTerminalEvent, reloadRecoveries]
  )

  const openMigration = useCallback((conversation: Conversation) => {
    dispatchDialog({ type: 'open', conversation })
  }, [])

  const setDestinationBranch = useCallback((value: string) => {
    dispatchDialog({ type: 'branch', value })
  }, [])

  const prepare = useCallback(async () => {
    const current = dialogRef.current
    const branch = current.destinationBranch.trim()
    if (!current.conversation || !branch || current.busy) return
    dispatchDialog({ type: 'prepare-start' })
    try {
      const preview = await window.api.prepareConversationMigration({
        conversationId: current.conversation.id,
        destinationBranch: branch,
      })
      dispatchDialog({ type: 'prepare-success', preview })
    } catch (error) {
      dispatchDialog({ type: 'failure', error: cleanIpcError(error) })
    }
  }, [])

  const editDestinationBranch = useCallback(async () => {
    const current = dialogRef.current
    if (!current.open || current.busy || !current.preview) return
    dispatchDialog({ type: 'cancel-start' })
    try {
      await window.api.cancelConversationMigration({ operationId: current.preview.operationId })
      dispatchDialog({ type: 'edit-branch' })
      await reloadRecoveries()
    } catch (error) {
      dispatchDialog({ type: 'failure', error: cleanIpcError(error) })
    }
  }, [reloadRecoveries])

  const closeMigration = useCallback(async () => {
    const current = dialogRef.current
    if (!current.open || current.busy) return
    if (!current.preview) {
      dispatchDialog({ type: 'close' })
      return
    }
    dispatchDialog({ type: 'cancel-start' })
    try {
      await window.api.cancelConversationMigration({ operationId: current.preview.operationId })
      dispatchDialog({ type: 'close' })
      await reloadRecoveries()
    } catch (error) {
      dispatchDialog({ type: 'failure', error: cleanIpcError(error) })
    }
  }, [reloadRecoveries])

  const toggleIgnored = useCallback((path: string, selected: boolean, sensitive: boolean) => {
    dispatchDialog({ type: 'toggle-ignored', path, selected, sensitive })
  }, [])

  const confirmSensitive = useCallback((path: string, confirmed: boolean) => {
    dispatchDialog({ type: 'confirm-sensitive', path, confirmed })
  }, [])

  const handleResult = useCallback(
    async (result: MigrationResult) => {
      dispatchDialog({ type: 'close' })
      await reloadRecoveries()
      if (result.status === 'completed') {
        await focusById(result.conversationId)
      }
    },
    [focusById, reloadRecoveries]
  )

  const execute = useCallback(async () => {
    const current = dialogRef.current
    if (!current.preview || current.busy) return
    dispatchDialog({ type: 'execute-start' })
    try {
      const result = await window.api.executeConversationMigration({
        operationId: current.preview.operationId,
        selectedIgnoredPaths: current.selectedIgnoredPaths,
        confirmedSensitivePaths: current.confirmedSensitivePaths,
      })
      await handleResult(result)
    } catch (error) {
      const currentRecoveries = await reloadRecoveries()
      if (currentRecoveries.some((recovery) => recovery.operationId === current.preview!.operationId)) {
        dispatchDialog({ type: 'close' })
      } else {
        dispatchDialog({ type: 'failure', error: cleanIpcError(error) })
      }
    }
  }, [handleResult, reloadRecoveries])

  const resolveRecovery = useCallback(
    async (recovery: MigrationRecovery, action: RecoveryAction) => {
      if (action === 'rollback' && !window.confirm(i18n.t('ui:conversationMigration.rollbackConfirm'))) return
      if (resolvingRef.current.has(recovery.operationId)) return
      resolvingRef.current.add(recovery.operationId)
      setResolvingRecovery({ operationId: recovery.operationId, action })
      setRecoveryError(null)
      try {
        const result = await window.api.resolveConversationMigration({
          operationId: recovery.operationId,
          action,
        })
        await reloadRecoveries()
        if (result.status === 'completed') {
          await focusById(result.conversationId)
        } else if (result.status === 'rolled-back') {
          await focusById(result.conversationId)
        } else {
          await refreshWorkspaces()
        }
      } catch (error) {
        setRecoveryError(cleanIpcError(error))
      } finally {
        resolvingRef.current.delete(recovery.operationId)
        setResolvingRecovery(null)
      }
    },
    [focusById, refreshWorkspaces, reloadRecoveries]
  )

  const retryRecoveries = useCallback(async () => {
    setRecoveries(null)
    setRecoveryError(null)
    await reloadRecoveries()
  }, [reloadRecoveries])

  const blockingRecoveries = useMemo(() => recoveries ?? [], [recoveries])

  return {
    dialog,
    openMigration,
    setDestinationBranch,
    prepare,
    closeMigration,
    editDestinationBranch,
    toggleIgnored,
    confirmSensitive,
    execute,
    recoveriesChecking: recoveries === null,
    retryRecoveries,
    blockingRecoveries,
    recoveryError,
    resolvingRecovery,
    resolveRecovery,
    navigationError,
  }
}
