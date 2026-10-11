import { APP_TOOL_GROUPS, type AppToolGroup, type AppToolGroupState } from '../../shared/app-tool-groups'
import { isBotMode } from '../fleet/instance/config'
import { getAppFlag, getConvUiPrefs, setAppFlag } from '../store'

/** Global app_settings flag for the whole app-tool surface. Default ON: the tools are part of the product core. */
export const APP_TOOLS_FLAG = 'chat.appTools'

const groupFlag = (group: AppToolGroup) => `${APP_TOOLS_FLAG}.group.${group}`

export function globalAppToolsEnabled(): boolean {
  return getAppFlag(APP_TOOLS_FLAG, true)
}

export function setGlobalAppToolsEnabled(enabled: boolean): void {
  setAppFlag(APP_TOOLS_FLAG, enabled)
}

export function globalAppToolGroups(): AppToolGroupState {
  return Object.fromEntries(
    APP_TOOL_GROUPS.map((group) => [group, getAppFlag(groupFlag(group), true)])
  ) as AppToolGroupState
}

export function setGlobalAppToolGroup(group: AppToolGroup, enabled: boolean): void {
  setAppFlag(groupFlag(group), enabled)
}

export interface AppToolAccess {
  /** Whole surface on/off: conversation override, else the global flag. */
  enabled: boolean
  /** Effective state of each group: conversation override per group, else the global group flag. */
  groups: AppToolGroupState
  /** Groups the user turned off, in APP_TOOL_GROUPS order. Applies even to the personal-memory-only surface. */
  disabledGroups: AppToolGroup[]
}

/**
 * Single resolution of the app-tool settings for a conversation. Bots ignore group settings: their browser,
 * screen and help tools must always be present.
 */
export function resolveAppToolAccess(conversationId: string): AppToolAccess {
  const prefs = getConvUiPrefs(conversationId).chat?.tools
  const enabled = prefs?.app ?? globalAppToolsEnabled()
  if (isBotMode()) {
    return {
      enabled,
      groups: Object.fromEntries(APP_TOOL_GROUPS.map((group) => [group, true])) as AppToolGroupState,
      disabledGroups: [],
    }
  }
  const global = globalAppToolGroups()
  const groups = Object.fromEntries(
    APP_TOOL_GROUPS.map((group) => [group, prefs?.appGroups?.[group] ?? global[group]])
  ) as AppToolGroupState
  return { enabled, groups, disabledGroups: APP_TOOL_GROUPS.filter((group) => !groups[group]) }
}
