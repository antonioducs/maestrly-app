import { useCallback, useEffect, useRef, useState } from 'react'
import type { Workspace } from '../../preload'
import type {
  EmptyRemoteDecision,
  ProjectSetupProgress,
  ProjectSetupRequest,
  ProjectSetupResult,
} from '../../shared/project-setup'

export type ProjectSetupMode = 'open' | 'create' | 'clone'

export interface ProjectSetupOptions {
  mode?: ProjectSetupMode
  allowedModes?: ProjectSetupMode[]
  remoteUrl?: string
  defaultBranch?: string
}

export interface ProjectSetupDialogState {
  open: boolean
  mode: ProjectSetupMode
  request: ProjectSetupRequest | null
  progress: ProjectSetupProgress | null
  result: ProjectSetupResult<Workspace> | null
  busy: boolean
  options: ProjectSetupOptions
}

interface PendingRequest {
  resolve: (workspace: Workspace | null) => void
}

export function useProjectSetup(reconcileWorkspace: (workspaceId: string) => Promise<Workspace | null>) {
  const [state, setState] = useState<ProjectSetupDialogState>({
    open: false,
    mode: 'open',
    request: null,
    progress: null,
    result: null,
    busy: false,
    options: {},
  })
  const pendingRef = useRef<PendingRequest | null>(null)
  const operationIdRef = useRef<string | null>(null)
  const inFlightRef = useRef<string | null>(null)
  const closeRequestedRef = useRef(false)

  useEffect(
    () =>
      window.api.onProjectSetupProgress((progress) => {
        if (progress.operationId !== operationIdRef.current) return
        setState((current) => ({ ...current, progress }))
      }),
    []
  )

  const closeAndResolve = useCallback((workspace: Workspace | null) => {
    operationIdRef.current = null
    inFlightRef.current = null
    closeRequestedRef.current = false
    setState({ open: false, mode: 'open', request: null, progress: null, result: null, busy: false, options: {} })
    pendingRef.current?.resolve(workspace)
    pendingRef.current = null
  }, [])

  const requestProject = useCallback((options: ProjectSetupOptions = {}): Promise<Workspace | null> => {
    if (pendingRef.current) return Promise.resolve(null)
    return new Promise((resolve) => {
      pendingRef.current = { resolve }
      closeRequestedRef.current = false
      setState({
        open: true,
        mode: options.mode ?? 'open',
        request: null,
        progress: null,
        result: null,
        busy: false,
        options,
      })
    })
  }, [])

  const start = useCallback(
    async (request: ProjectSetupRequest) => {
      if (inFlightRef.current) return null
      inFlightRef.current = request.operationId
      operationIdRef.current = request.operationId
      closeRequestedRef.current = false
      setState((current) => ({ ...current, request, progress: null, result: null, busy: true }))
      let result: ProjectSetupResult<Workspace>
      try {
        result = await window.api.startProjectSetup(request)
      } catch {
        result = {
          status: 'error',
          error: { code: request.kind === 'clone' ? 'clone-failed' : 'initialization-failed' },
        }
      }
      if (operationIdRef.current !== request.operationId) return result
      inFlightRef.current = null
      if (result.status === 'success') {
        let canonical = result.workspace
        try {
          canonical = (await reconcileWorkspace(result.workspace.id)) ?? result.workspace
        } catch {}

        closeAndResolve(canonical)
      } else {
        operationIdRef.current = null
        closeRequestedRef.current = false
        setState((current) => ({ ...current, result, progress: null, busy: false }))
        if (result.status === 'canceled') closeAndResolve(null)
      }
      return result
    },
    [closeAndResolve, reconcileWorkspace]
  )

  const resolveEmptyRemote = useCallback(async (decision: EmptyRemoteDecision) => {
    const operationId = operationIdRef.current
    if (!operationId || inFlightRef.current !== operationId) return
    inFlightRef.current = `decision:${operationId}`
    if (decision === 'cancel') {
      setState((current) => ({
        ...current,
        progress: { operationId, phase: 'canceling' },
        busy: true,
      }))
    }
    try {
      const accepted = await window.api.resolveEmptyRemoteProjectSetup(operationId, decision)
      if (!accepted && operationIdRef.current === operationId) {
        inFlightRef.current = operationId
        setState((current) => ({
          ...current,
          progress: { operationId, phase: 'awaiting-empty-remote-confirmation' },
          busy: true,
        }))
      }
    } catch {
      if (operationIdRef.current === operationId) {
        inFlightRef.current = operationId
        setState((current) => ({
          ...current,
          progress: { operationId, phase: 'awaiting-empty-remote-confirmation' },
          busy: true,
        }))
      }
    }
  }, [])

  const close = useCallback(async () => {
    const operationId = operationIdRef.current
    if (!operationId) {
      closeAndResolve(null)
      return
    }
    if (closeRequestedRef.current) return
    closeRequestedRef.current = true
    setState((current) => ({
      ...current,
      progress: { operationId, phase: 'canceling' },
      busy: true,
    }))
    try {
      const accepted = await window.api.cancelProjectSetup(operationId)

      if (!accepted && operationIdRef.current === operationId) closeRequestedRef.current = false
    } catch {
      if (operationIdRef.current === operationId) {
        closeRequestedRef.current = false
        setState((current) => ({ ...current, progress: null, busy: true }))
      }
    }
  }, [closeAndResolve])

  return {
    state,
    setMode: (mode: ProjectSetupMode) => setState((current) => ({ ...current, mode, result: null, progress: null })),
    requestProject,
    start,
    resolveEmptyRemote,
    close,
  }
}
