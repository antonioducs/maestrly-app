import type { ExportedPackage } from '../../shared/conversation-move'
import { type HostId, isRemoteHostId } from '../../shared/host-key'
import type { HostTransferView } from '../../shared/host-transfers'
import type { HostTransferEngine } from '../host-transfers/engine'
import { MoveError } from './errors'

/** Carries a move's package from its source host to its target host through this computer's transfer queue. */
export type PackageRelay = (args: {
  operationId: string
  from: HostId
  to: HostId
  pkg: ExportedPackage
  /** The target's staging folder, for a remote target. */
  targetDirectory: string | null
  /** This computer's staging folder, where a package from a remote source lands. */
  localDirectory: string
  onProgress: (progress: { doneBytes: number; size: number }) => void
}) => Promise<{ path: string; transferIds: string[] }>

const failed = (view: HostTransferView): MoveError =>
  new MoveError('transfer-failed', view.errorMessage ?? view.error ?? `The transfer ended ${view.state}.`)

export function createPackageRelay(engine: () => HostTransferEngine | null): PackageRelay {
  return async ({ from, to, pkg, targetDirectory, localDirectory, onProgress }) => {
    const transferIds: string[] = []
    let current = pkg.path
    if (!isRemoteHostId(from) && !isRemoteHostId(to)) return { path: current, transferIds }
    const queue = engine()
    if (!queue) throw new MoveError('host-unavailable', 'This computer cannot transfer files to its hosts.')
    const progress = (view: HostTransferView) => onProgress({ doneBytes: view.doneBytes, size: view.size })
    if (isRemoteHostId(from)) {
      const id = await queue.download(from, pkg.path, 'save', { directory: localDirectory })
      transferIds.push(id)
      const view = await queue.whenSettled(id, progress)
      if (view.state !== 'done' || !view.localPath) throw failed(view)
      if (view.sha256 && view.sha256 !== pkg.sha256)
        throw new MoveError('transfer-failed', 'The package changed while it was downloaded.')
      current = view.localPath
    }
    if (isRemoteHostId(to)) {
      if (!targetDirectory) throw new MoveError('transfer-failed', 'The destination has no staging folder.')
      // A retried move replaces the package an interrupted attempt already left there.
      const { queued, skipped } = await queue.upload(to, [current], targetDirectory, true)
      if (queued.length !== 1)
        throw new MoveError('transfer-failed', `The package cannot be uploaded: ${skipped.join(', ')}`)
      transferIds.push(queued[0])
      const view = await queue.whenSettled(queued[0], progress)
      if (view.state !== 'done') throw failed(view)
      if (view.sha256 && view.sha256 !== pkg.sha256)
        throw new MoveError('transfer-failed', 'The package changed while it was uploaded.')
      current = view.remotePath
    }
    return { path: current, transferIds }
  }
}
