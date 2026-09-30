import path from 'node:path'
import type { RuntimeAssetStatus } from '../../../shared/runtime-assets'
import { runtimeAssetService } from '../../runtime-assets/app-service'
import { compareStableVersions } from '../../runtime-assets/npm-registry'
import { type CodexRuntimeResolution, resolveCodexRuntime } from './runtime-resolver'

export interface BotCodexRuntimeDependencies {
  /** The runtime the bot image ships (`resources/codex`). */
  readonly image?: () => CodexRuntimeResolution
  readonly managed?: () => Promise<RuntimeAssetStatus>
  readonly resolveManaged?: (assetPath: string) => CodexRuntimeResolution
}

/**
 * The Codex a bot runs: its managed installation when strictly newer than the one its image ships, else the image's.
 * The image stays the floor, so a bot never runs an older Codex than the build it was tested with.
 */
export async function resolveBotCodexRuntime(
  dependencies: BotCodexRuntimeDependencies = {}
): Promise<CodexRuntimeResolution> {
  const readImage = dependencies.image ?? (() => resolveCodexRuntime())
  const readManaged = dependencies.managed ?? (() => runtimeAssetService().status('codex-runtime'))
  const resolveManaged =
    dependencies.resolveManaged ??
    ((managedAssetPath: string) => resolveCodexRuntime({ isPackaged: true, managedAssetPath }))
  let image: CodexRuntimeResolution | null = null
  let imageError: unknown = null
  try {
    image = readImage()
  } catch (error) {
    imageError = error
  }
  const managed = await readManaged().catch(() => null)
  if (
    managed?.state === 'ready' &&
    managed.path &&
    managed.version &&
    (compareStableVersions(managed.version, image?.version ?? '0.0.0') ?? 0) > 0
  ) {
    return resolveManaged(managed.path)
  }
  if (image) return image
  throw imageError
}

/** Whether an executable belongs to a managed Codex installation, which a connection must lease while it runs. */
export function isManagedCodexPath(executablePath: string, root: string = runtimeAssetService().root): boolean {
  const relative = path.relative(path.join(path.resolve(root), 'codex-runtime'), path.resolve(executablePath))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
