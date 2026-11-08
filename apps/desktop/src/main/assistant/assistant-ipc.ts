import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  ASSISTANT_OPENAI_VOICES,
  type AssistantInfo,
  type AssistantSettings,
  type AssistantSettingsState,
  type AssistantVoiceOptions,
  assistantVoiceSchema,
} from '../../shared/assistant'
import type { IpcRegistrar } from '../ipc-registrar'
import { ensureAssistantConversation, startNewAssistantSession } from './assistant-conversation'
import { getAssistantSettings, setAssistantSettings } from './assistant-settings'
import type { AssistantWindow } from './assistant-window'
import { hangUpRealtimeCall, type RealtimeStartResult, startRealtimeCall } from './realtime/session'
import {
  createSpeechRequests,
  OPENAI_SPEECH_MAX_CHARS,
  openAiSpeechKey,
  synthesizeOpenAiSpeech,
  type TtsResult,
} from './tts'

export interface AssistantIpcDeps {
  window(): AssistantWindow | null
  /** This computer's locale, for the voice's instructions. */
  locale(): string
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
  const speech = createSpeechRequests()
  const ttsInput = z.object({ text: z.string().min(1).max(OPENAI_SPEECH_MAX_CHARS) }).strict()
  reg.mhandle('assistant:tts', async (event, input: unknown): Promise<TtsResult> => {
    if (!isAssistantSender(deps, event)) throw new Error('Only the assistant window reads answers aloud')
    const { text } = ttsInput.parse(input)
    const { voice } = getAssistantSettings()
    return speech.speak(text, { voice: voice.openaiVoice, speed: voice.speed, locale: deps.locale() })
  })
  reg.mon('assistant:tts-cancel', (event) => {
    if (isAssistantSender(deps, event)) speech.cancel()
  })
  // One Realtime call at a time, for the assistant window only; stopping it hangs it up on OpenAI's side too.
  let realtimeCall: string | null = null
  const stopRealtime = () => {
    const callId = realtimeCall
    realtimeCall = null
    if (callId) void hangUpRealtimeCall(callId)
  }
  reg.mhandle('assistant:realtime-start', async (event, input: unknown): Promise<RealtimeStartResult> => {
    if (!isAssistantSender(deps, event)) throw new Error('Only the assistant window starts a voice call')
    const { sdp } = z
      .object({
        sdp: z
          .string()
          .min(1)
          .max(64 * 1024),
      })
      .strict()
      .parse(input)
    stopRealtime()
    const { voice } = getAssistantSettings()
    const result = await startRealtimeCall(sdp, {
      model: voice.realtimeModel,
      voice: voice.realtimeVoice,
      speed: voice.speed,
      locale: deps.locale(),
    })
    if (result.ok) realtimeCall = result.callId
    return result
  })
  reg.mon('assistant:realtime-stop', (event) => {
    if (isAssistantSender(deps, event)) stopRealtime()
  })
  reg.handle(
    'assistant:voices',
    async (): Promise<AssistantVoiceOptions> => ({
      openai: [...ASSISTANT_OPENAI_VOICES],
      openaiKey: !!(await openAiSpeechKey().catch(() => null)),
    })
  )
  // Settings try a voice before choosing it: the sample sentence, read once with the voice and speed given.
  const testInput = z
    .object({
      text: z.string().trim().min(1).max(200),
      voice: assistantVoiceSchema.shape.openaiVoice.optional(),
      speed: assistantVoiceSchema.shape.speed.optional(),
    })
    .strict()
  reg.mhandle('assistant:test-voice', (_event, input: unknown): Promise<TtsResult> => {
    const { text, voice, speed } = testInput.parse(input)
    const current = getAssistantSettings().voice
    return synthesizeOpenAiSpeech(text, {
      voice: voice ?? current.openaiVoice,
      speed: speed ?? current.speed,
      locale: deps.locale(),
      signal: AbortSignal.timeout(30_000),
    })
  })
  reg.mon('assistant:hold', (event, reason: unknown, held: unknown) => {
    if (!isAssistantSender(deps, event)) return
    const parsed = z.enum(['question', 'listening', 'speaking']).safeParse(reason)
    if (parsed.success) deps.window()?.setHold(parsed.data, held === true)
  })
}
