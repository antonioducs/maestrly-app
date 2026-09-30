/**
 * Which IPC channels another computer's renderer may use on a host through the bridge. Local-only channels drive the
 * calling computer's own window, native views, devices and app; desktop-effect channels open windows, dialogs or files
 * on the host's own desktop, which nobody sees on a server.
 */
const LOCAL_ONLY_PREFIXES = ['fleet:', 'update:', 'sound:', 'popup:', 'float:', 'performance:', 'host:', 'hosts:']
const LOCAL_ONLY_CHANNELS = new Set([
  'app:info',
  'open:url',
  'chat:ensure-mic-access',
  'chat:transcribe',
  'drawer:suppress-views',
  'drawer:layout',
  'drawer:capture-slot',
  'drawer:load-vscode',
  'drawer:restart-vscode',
  'drawer:dispose-conversation',
  'drawer:ensure-panel',
  'drawer:detach',
  'drawer:reattach',
  'drawer:set-float-bounds',
  'drawer:visible-conversation',
  'drawer:floating-state-get',
  'drawer:chatgpt-visible',
  'panel:memory-eviction-ready',
  'settings:onboarding-get',
  'settings:onboarding-set',
  'settings:sound-get',
  'settings:sound-set',
  'settings:sound-preview',
  'settings:shortcuts-get',
  'settings:shortcuts-set',
  'settings:close-shortcut-set',
  'settings:drawer-shortcut-set',
  'settings:shortcut-open-mode-set',
  'settings:default-main-tab-order-get',
  'settings:default-main-tab-order-set',
  'settings:locale-get',
  'settings:locale-set',
])

export const HOST_DESKTOP_EFFECT_CHANNELS: ReadonlySet<string> = new Set([
  'open:targets',
  'open:external',
  'chat:open-attachment-pdf',
  'chat:skills:reveal',
  'memory:shared-open',
  'data:export',
  'data:reset',
  'workspace:pick',
  'project-setup:pick-directory',
  'plan:open-file',
])

export type RemoteChannelRefusal = 'local-only' | 'desktop-effect'

/** Why a host refuses a channel from another computer's renderer, or null when it may run. */
export function remoteChannelRefusal(channel: string): RemoteChannelRefusal | null {
  if (LOCAL_ONLY_CHANNELS.has(channel) || LOCAL_ONLY_PREFIXES.some((prefix) => channel.startsWith(prefix)))
    return 'local-only'
  return HOST_DESKTOP_EFFECT_CHANNELS.has(channel) ? 'desktop-effect' : null
}
