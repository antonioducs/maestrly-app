/**
 * Which IPC channels another computer's renderer may use on a host through the bridge. Local-only channels drive the
 * calling computer's own window, native views, devices and app; desktop-effect channels open windows, dialogs or files
 * on the host's own desktop, which nobody sees on a server.
 */
// `artifacts:` is this computer's artifacts center, which reaches the paired server's artifacts itself; `chat-window:`
// opens a conversation of this computer in a window of its own; `transfers:` drives this computer's own transfer queue;
// `conversation-move:` is the move coordinator, which runs on this computer only (hosts serve
// `conversation-move-endpoint:` to it instead).
const LOCAL_ONLY_PREFIXES = [
  'fleet:',
  'update:',
  'sound:',
  'popup:',
  'float:',
  'performance:',
  'host:',
  'hosts:',
  'artifacts:',
  'chat-window:',
  'transfers:',
  // Signing in to an MCP server opens this computer's browser and listens on its loopback, whichever host runs it.
  'mcp-oauth:',
  'conversation-move:',
]
const LOCAL_ONLY_CHANNELS = new Set([
  'app:info',
  'open:url',
  'chat:ensure-mic-access',
  'chat:transcribe',
  'chat:asr-warm',
  'chat:asr-support',
  'drawer:suppress-views',
  'drawer:layout',
  'drawer:capture-slot',
  // The address-bar overlay moves this computer's native page; a remote host's page is streamed into the DOM.
  'drawer:omnibox-overlay',
  // Which renderer of this computer catches the browser tab shortcuts.
  'drawer:browser-keyboard-focus',
  'drawer:load-vscode',
  'drawer:restart-vscode',
  'drawer:dispose-conversation',
  'drawer:ensure-panel',
  'drawer:detach',
  'drawer:reattach',
  'drawer:set-float-bounds',
  'drawer:visible-conversation',
  'drawer:floating-state-get',
  'drawer:placement-get',
  'drawer:remote-conversations',
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
  // The host's main process writes to the clipboard of its own desktop.
  'chat:chatgpt-web:companion-copy-prompt',
  'chat:chatgpt-web:companion-copy-session-key',
  'project-setup:projects-directory-pick',
])

/**
 * Channels a host serves only to another computer: the conversation's browser, streamed to that computer's window, its
 * editor, which that computer's main process opens and drives, and its computer, which that window watches through
 * the gateway. A window of the host itself shows the first two natively and has no computer, so their handlers refuse
 * every local sender.
 */
export const REMOTE_VIEWER_CHANNELS: ReadonlySet<string> = new Set([
  'editor:open',
  'editor:status',
  'editor:restart',
  'editor:navigate',
  'editor:snapshot',
  'drawer:browser-stream-start',
  'drawer:browser-stream-resize',
  'drawer:browser-stream-ack',
  'drawer:browser-stream-stop',
  'drawer:browser-input',
  'drawer:browser-copy',
  'drawer:browser-paste',
  'drawer:browser-select-choose',
  'drawer:browser-popup-close',
  'drawer:browser-stream-transport',
  'drawer:computer-open',
])

export type RemoteChannelRefusal = 'local-only' | 'desktop-effect'

/** Why a host refuses a channel from another computer's renderer, or null when it may run. */
export function remoteChannelRefusal(channel: string): RemoteChannelRefusal | null {
  if (LOCAL_ONLY_CHANNELS.has(channel) || LOCAL_ONLY_PREFIXES.some((prefix) => channel.startsWith(prefix)))
    return 'local-only'
  return HOST_DESKTOP_EFFECT_CHANNELS.has(channel) ? 'desktop-effect' : null
}
