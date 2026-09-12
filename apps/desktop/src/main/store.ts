/**
 * Local SQLite persistence for workspaces and conversations. The app owns conversation/session
 * identity mapping.
 */

/**
 * Drawer tabs can detach or open as centered popups. The pure shared/tool-tabs.ts is the single
 * source, reexported for drawer and window callers.
 */
export type { FloatTab } from '../shared/tool-tabs'

export * from './store/db'
export * from './store/app-settings'
export * from './store/settings'
export * from './store/workspaces'
export * from './store/local-memories'
export * from './store/conversations'
export * from './store/legacy-conversation-import'
