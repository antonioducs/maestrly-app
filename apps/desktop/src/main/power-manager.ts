import { powerSaveBlocker } from 'electron'
import { getAppFlag, setAppFlag } from './store'

/**
 * Keep the system awake while at least one agent is working so long tasks survive idle periods. Screen
 * locking does not suspend PTYs; system sleep does. Electron's prevent-app-suspension assertion
 * permits display sleep. registry.on('status') maintains the working-agent set and toggles the
 * assertion when it crosses zero. The persisted setting defaults on. On Linux, unavailable logind/DBus
 * can make start throw or fail silently: check isStarted, keep blockerId null on failure, and retry on
 * future transitions without crashing. Apply the same defensive handling on macOS/Windows.
 */

/** Setting key in app_settings. */
const SETTING_KEY = 'preventSleepWhileWorking'

/** Agent IDs currently working; other statuses leave the set. */
const working = new Set<string>()
/** Active power assertion ID, or null when none exists. */
let blockerId: number | null = null
/** In-memory copy of the persisted flag, loaded by initPowerManager. */
let enabled = true

/** Idempotently toggle the assertion when enabled and work exists. */
function reconcile(): void {
  const shouldBlock = enabled && working.size > 0
  if (shouldBlock && blockerId === null) {
    // Linux logind/DBus may be unavailable in headless or container sessions. Catch start failures and
    // verify isStarted; leave blockerId null so future transitions retry without preventing sleep.
    try {
      const id = powerSaveBlocker.start('prevent-app-suspension')
      blockerId = powerSaveBlocker.isStarted(id) ? id : null
      if (blockerId === null)
        console.warn(
          '[power] powerSaveBlocker did not activate (logind/DBus unavailable?); continuing without preventing sleep'
        )
    } catch (e) {
      blockerId = null
      console.warn('[power] powerSaveBlocker.start failed:', (e as Error).message)
    }
  } else if (!shouldBlock && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

/** Load the persisted flag, default on. Call after initStore in app.whenReady. */
export function initPowerManager(): void {
  enabled = getAppFlag(SETTING_KEY, true)
  reconcile()
}

/** Maintain the working-agent set from the single registry.on('status') entry point. */
export function onAgentStatus(agentId: string, status: string): void {
  if (status === 'working') working.add(agentId)
  else working.delete(agentId) // ready | idle | waiting | error releases this agent
  reconcile()
}

/** Remove a terminated agent; it can no longer emit ready after kill, deletion, CLI switch, or crash. */
export function forgetAgent(agentId: string): void {
  if (working.delete(agentId)) reconcile()
}

/** Whether the persisted feature setting is enabled. */
export function isPreventSleepEnabled(): boolean {
  return enabled
}

/** Persist enablement; disabling immediately releases the assertion and enabling reevaluates it. */
export function setPreventSleepEnabled(value: boolean): void {
  enabled = value
  setAppFlag(SETTING_KEY, value)
  reconcile()
}

/** Unconditionally release the assertion and clear state before quit. */
export function releasePowerBlocker(): void {
  working.clear()
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
  blockerId = null
}
