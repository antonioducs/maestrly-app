import { BrowserWindow, dialog, type WebContents } from 'electron'
import type { IpcRegistrar } from '../ipc-registrar'
import type { Workspace } from '../store'
import type {
  EmptyRemoteDecision,
  ProjectSetupProgress,
  ProjectSetupRequest,
  ProjectSetupResult,
} from '../../shared/project-setup'
import { isProjectSetupRequest } from '../../shared/project-setup'
import { projectSetupService, type ProjectSetupContext } from './service'
import { consumeE2EProjectPicker } from '../test-mode'

interface OperationRecord {
  operationId: string
  senderId: number
  sender: WebContents
  controller: AbortController
  state: 'running' | 'awaiting-empty-remote' | 'canceling' | 'committed' | 'terminal'
  resolveEmptyRemote?: (decision: EmptyRemoteDecision) => void
  onDestroyed: () => void
  completion: Promise<void>
  resolveCompletion: () => void
}

export interface ProjectSetupIpcDeps {
  service?: {
    execute: (request: ProjectSetupRequest, context: ProjectSetupContext) => Promise<ProjectSetupResult<Workspace>>
  }
  showDirectoryPicker?: (window: BrowserWindow, purpose: 'open' | 'parent') => Promise<string | null>
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function registerProjectSetupIpc(
  reg: IpcRegistrar,
  deps: ProjectSetupIpcDeps = {}
): { cancelAndWait: () => Promise<void> } {
  const service = deps.service ?? projectSetupService
  const operations = new Map<string, OperationRecord>()
  let shuttingDown = false

  const cancelRecord = (record: OperationRecord): boolean => {
    if (record.state === 'canceling') return true
    if (record.state === 'terminal' || record.state === 'committed') return false
    record.state = 'canceling'
    if (!record.sender.isDestroyed()) {
      try {
        record.sender.send('project-setup:progress', {
          operationId: record.operationId,
          phase: 'canceling',
        } satisfies ProjectSetupProgress)
      } catch {
        // sender closed during cancellation; AbortController remains authoritative.
      }
    }
    record.controller.abort()
    record.resolveEmptyRemote?.('cancel')
    record.resolveEmptyRemote = undefined
    return true
  }

  const cancelAndWait = async (): Promise<void> => {
    shuttingDown = true
    while (operations.size > 0) {
      const active = [...operations.values()]
      for (const record of active) cancelRecord(record)
      await Promise.allSettled(active.map((record) => record.completion))
    }
  }

  reg.mhandle('project-setup:pick-directory', async (event, purpose: 'open' | 'parent') => {
    if (purpose !== 'open' && purpose !== 'parent') return null
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    if (deps.showDirectoryPicker) return deps.showDirectoryPicker(window, purpose)
    const e2ePath = consumeE2EProjectPicker()
    if (e2ePath !== undefined) return e2ePath
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  reg.mhandle('project-setup:start', async (event, request: ProjectSetupRequest) => {
    if (
      shuttingDown ||
      !isProjectSetupRequest(request) ||
      !UUID_PATTERN.test(request.operationId) ||
      operations.has(request.operationId)
    ) {
      return {
        status: 'error',
        error: {
          code: shuttingDown || operations.has(request?.operationId) ? 'operation-conflict' : 'invalid-request',
        },
      } satisfies ProjectSetupResult<Workspace>
    }

    const sender = event.sender
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    const record: OperationRecord = {
      operationId: request.operationId,
      senderId: sender.id,
      sender,
      controller: new AbortController(),
      state: 'running',
      onDestroyed: () => {},
      completion,
      resolveCompletion,
    }
    record.onDestroyed = () => cancelRecord(record)
    operations.set(request.operationId, record)
    sender.once('destroyed', record.onDestroyed)

    const emit: ProjectSetupContext['emit'] = (progress) => {
      if (record.state === 'terminal' || sender.isDestroyed()) return
      if (progress.phase === 'awaiting-empty-remote-confirmation') {
        record.state = 'awaiting-empty-remote'
      }
      try {
        sender.send('project-setup:progress', { operationId: request.operationId, ...progress })
      } catch {
        // Renderer destruction can race send after isDestroyed; lifecycle cancellation already aborts the
        // operation.
      }
    }

    try {
      return await service.execute(request, {
        signal: record.controller.signal,
        emit,
        markCommitted: () => {
          record.state = 'committed'
        },
        waitForEmptyRemoteDecision: () =>
          new Promise<EmptyRemoteDecision>((resolve) => {
            if (record.controller.signal.aborted) {
              resolve('cancel')
              return
            }
            record.state = 'awaiting-empty-remote'
            record.resolveEmptyRemote = resolve
          }),
      })
    } finally {
      record.state = 'terminal'
      record.resolveEmptyRemote?.('cancel')
      record.resolveEmptyRemote = undefined
      sender.removeListener('destroyed', record.onDestroyed)
      operations.delete(request.operationId)
      record.resolveCompletion()
    }
  })

  reg.mhandle('project-setup:cancel', (event, operationId: string) => {
    const record = operations.get(operationId)
    if (!record || record.senderId !== event.sender.id) return false
    return cancelRecord(record)
  })

  reg.mhandle('project-setup:resolve-empty-remote', (event, payload: { operationId?: unknown; decision?: unknown }) => {
    const operationId = typeof payload?.operationId === 'string' ? payload.operationId : ''
    const decision = payload?.decision
    const record = operations.get(operationId)
    if (
      !record ||
      record.senderId !== event.sender.id ||
      record.state !== 'awaiting-empty-remote' ||
      (decision !== 'initialize-local' && decision !== 'cancel') ||
      !record.resolveEmptyRemote
    ) {
      return false
    }
    const resolve = record.resolveEmptyRemote
    if (decision === 'cancel') {
      cancelRecord(record)
      resolve('cancel')
    } else {
      record.resolveEmptyRemote = undefined
      record.state = 'running'
      resolve(decision)
    }
    return true
  })

  return { cancelAndWait }
}
