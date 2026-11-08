import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AssistantInfo, AssistantSettings, AssistantSettingsState } from '../../shared/assistant'
import type { IpcRegistrar } from '../ipc-registrar'
import { ensureAssistantConversation, startNewAssistantSession } from './assistant-conversation'
import { getAssistantSettings, setAssistantSettings } from './assistant-settings'
import type { AssistantWindow } from './assistant-window'

export interface AssistantIpcDeps {
  window(): AssistantWindow | null
  /** Show the main window on a conversation. */
  openConversationInApp(conversationId: string): void
  /** Show the main window on a Settings section. */
  openSettingsInApp(section: string | null): void
  /** Apply settings that changed (the shortcut); returns why the shortcut could not be registered. */
  applySettings(settings: AssistantSettings): 'conflict' | 'unsupported' | null
  shortcutError(): 'conflict' | 'unsupported' | null
  wayland: boolean
}

/** Only the assistant window itself may drive its window, voice and realtime channels. */
export function isAssistantSender(deps: Pick<AssistantIpcDeps, 'window'>, event: IpcMainEvent | IpcMainInvokeEvent) {
  const wc = deps.window()?.webContents()
  return !!wc && event.sender === wc
}

async function info(): Promise<AssistantInfo> {
  const conversation = await ensureAssistantConversation()
  return { conversationId: conversation.id, cwd: conversation.cwd }
}

export function registerAssistantIpc(reg: IpcRegistrar, deps: AssistantIpcDeps): void {
  const state = (settings: AssistantSettings = getAssistantSettings()): AssistantSettingsState => ({
    settings,
    shortcutError: deps.shortcutError(),
    wayland: deps.wayland,
  })

  reg.handle('assistant:info', () => info())
  reg.handle('assistant:settings-get', () => state())
  reg.mhandle('assistant:settings-set', (_event, patch: unknown) => {
    const settings = setAssistantSettings(patch)
    const error = deps.applySettings(settings)
    return { ...state(settings), shortcutError: error }
  })
  reg.mhandle('assistant:new-session', async () => {
    const conversation = await startNewAssistantSession()
    const window = deps.window()
    if (window) {
      await window.retarget()
      window.send('assistant:conversation-changed', { conversationId: conversation.id, cwd: conversation.cwd })
    }
    return { conversationId: conversation.id, cwd: conversation.cwd } satisfies AssistantInfo
  })
  reg.mhandle('assistant:open-in-app', async (event) => {
    const { conversationId } = await info()
    if (isAssistantSender(deps, event)) deps.window()?.hide()
    deps.openConversationInApp(conversationId)
  })
  reg.mhandle('assistant:open-settings', (event, section: unknown) => {
    if (isAssistantSender(deps, event)) deps.window()?.hide()
    deps.openSettingsInApp(
      z
        .string()
        .max(40)
        .nullable()
        .catch(null)
        .parse(section ?? null)
    )
  })
  reg.mhandle('assistant:show', (_event, listen: unknown) => deps.window()?.show({ listen: listen === true }))
  reg.mon('assistant:hide', (event) => {
    if (isAssistantSender(deps, event)) deps.window()?.hide()
  })
  reg.mon('assistant:hold', (event, reason: unknown, held: unknown) => {
    if (!isAssistantSender(deps, event)) return
    const parsed = z.enum(['question', 'listening', 'speaking']).safeParse(reason)
    if (parsed.success) deps.window()?.setHold(parsed.data, held === true)
  })
}
