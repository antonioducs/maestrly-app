import { RUNTIME_ASSET_IDS, type RuntimeAssetId } from '../../shared/runtime-assets'
import { isBotMode } from '../fleet/instance/config'

/** Runtimes the component manager handles only inside bots; the desktop app uses the system install instead. */
const BOT_ONLY_RUNTIME_ASSET_IDS: ReadonlySet<RuntimeAssetId> = new Set(['claude-code-runtime'])

/** Runtime assets this process lists and accepts over IPC. */
export function listedRuntimeAssetIds(botMode: boolean = isBotMode()): readonly RuntimeAssetId[] {
  return botMode ? RUNTIME_ASSET_IDS : RUNTIME_ASSET_IDS.filter((id) => !BOT_ONLY_RUNTIME_ASSET_IDS.has(id))
}

export function isListedRuntimeAssetId(value: unknown, botMode: boolean = isBotMode()): value is RuntimeAssetId {
  return typeof value === 'string' && listedRuntimeAssetIds(botMode).includes(value as RuntimeAssetId)
}
