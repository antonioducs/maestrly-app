import path from 'node:path'
import type { RuntimeAssetLease } from '../../../shared/runtime-assets'
import { acquireRuntimeAssetLease, runtimeAssetService } from '../../runtime-assets/app-service'
import { compareStableVersions } from '../../runtime-assets/npm-registry'
import { CLAUDE_CODE_PINNED_VERSION } from '../../runtime-assets/registry'
import { bundledClaudeCandidate, resolveClaude } from './resolve-claude'

export interface ClaudeExecutable {
  readonly path: string
  readonly version: string | null
  readonly source: 'managed' | 'image'
}

/** The executable one query runs on; releasing it lets a replaced installation go once no query needs it. */
export interface RetainedClaudeExecutable {
  readonly path: string
  /** Idempotent. */
  release(): void
}

export interface ClaudeRuntimeSelectionDependencies {
  readonly image: () => ClaudeExecutable
  readonly managed: () => Promise<{ path: string; version: string } | null>
  readonly acquireLease: (executablePath: string) => Promise<RuntimeAssetLease>
}

interface Handle {
  readonly executable: ClaudeExecutable
  lease: RuntimeAssetLease | null
  refs: number
  retired: boolean
}

/**
 * Which Claude Code a bot runs. Claude starts one process per query, so a switch never interrupts work: each query
 * retains the executable it started with, new queries take the current one, and the installation a switch replaced
 * keeps its lease until the last query using it closes. A managed installation is used only when strictly newer
 * than the one the image ships.
 */
export class ClaudeRuntimeSelection {
  private readonly dependencies: ClaudeRuntimeSelectionDependencies
  private handle: Handle | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dependencies: ClaudeRuntimeSelectionDependencies) {
    this.dependencies = dependencies
  }

  private currentHandle(): Handle {
    this.handle ??= { executable: this.dependencies.image(), lease: null, refs: 0, retired: false }
    return this.handle
  }

  current(): ClaudeExecutable {
    return this.currentHandle().executable
  }

  retain(): RetainedClaudeExecutable {
    const handle = this.currentHandle()
    handle.refs += 1
    let released = false
    return {
      path: handle.executable.path,
      release: () => {
        if (released) return
        released = true
        handle.refs -= 1
        this.releaseIfUnused(handle)
      },
    }
  }

  /** Re-selects after the managed installation changed; serialized. True when new queries now use another path. */
  refresh(): Promise<boolean> {
    const next = this.queue.then(() => this.performRefresh())
    this.queue = next.catch(() => undefined)
    return next
  }

  private async performRefresh(): Promise<boolean> {
    const image = this.dependencies.image()
    const managed = await this.dependencies.managed().catch(() => null)
    const useManaged = managed !== null && (compareStableVersions(managed.version, image.version ?? '0.0.0') ?? 0) > 0
    const target: ClaudeExecutable = useManaged
      ? { path: managed.path, version: managed.version, source: 'managed' }
      : image
    const previous = this.currentHandle()
    if (previous.executable.path === target.path) return false
    let lease: RuntimeAssetLease | null = null
    if (target.source === 'managed') {
      try {
        lease = await this.dependencies.acquireLease(target.path)
      } catch (error) {
        console.warn('[claude-runtime] Keeping the current Claude Code: the managed one could not be leased', error)
        return false
      }
    }
    this.handle = { executable: target, lease, refs: 0, retired: false }
    previous.retired = true
    this.releaseIfUnused(previous)
    return true
  }

  private releaseIfUnused(handle: Handle): void {
    if (!handle.retired || handle.refs > 0 || !handle.lease) return
    const lease = handle.lease
    handle.lease = null
    lease.release()
  }
}

let botSelection: ClaudeRuntimeSelection | null = null

/** The selection a bot's Claude managers use: the image's Claude Code, or a newer managed installation. */
export function botClaudeRuntime(): ClaudeRuntimeSelection {
  botSelection ??= new ClaudeRuntimeSelection({
    image: () => {
      const resolved = resolveClaude()
      return {
        path: resolved,
        version: resolved === bundledClaudeCandidate() ? CLAUDE_CODE_PINNED_VERSION : null,
        source: 'image',
      }
    },
    managed: async () => {
      const status = await runtimeAssetService().status('claude-code-runtime')
      return status.state === 'ready' && status.path && status.version
        ? { path: path.join(status.path, 'claude'), version: status.version }
        : null
    },
    acquireLease: (executablePath) => acquireRuntimeAssetLease('claude-code-runtime', executablePath),
  })
  return botSelection
}
