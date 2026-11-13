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
import { hangUpRealtimeCall, REALTIME_TOOLS, type RealtimeStartResult, startRealtimeCall } from './realtime/session'
import { assistantRealtimeBridgeDeps, createRealtimeToolBridge } from './realtime/tool-bridge'
import type { WakeStatus } from '../wake-service'
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
  wake: {
    burst(audio: unknown): Promise<void>
    micFailed(): void
    state(): { listening: boolean }
    status(): WakeStatus
  }
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
  /** The voice session's tool bridge: it keeps the confirmation a turn waits for, and stops with the call. */
  let realtime: { bridge: ReturnType<typeof createRealtimeToolBridge>; heard: string[]; stop: AbortController } | null =
    null
  const newRealtimeSession = () => {
    const session = {
      heard: [] as string[],
      stop: new AbortController(),
      bridge: null as unknown as ReturnType<typeof createRealtimeToolBridge>,
    }
    session.bridge = createRealtimeToolBridge(
      assistantRealtimeBridgeDeps({
        wc: () => deps.window()?.webContents() ?? null,
        conversationId: async () => (await ensureAssistantConversation()).id,
        heard: () => session.heard,
        locale: () => (deps.locale() === 'pt-BR' ? 'pt-BR' : 'en'),
      })
    )
    realtime = session
    return session
  }
  const stopRealtime = () => {
    const callId = realtimeCall
    realtimeCall = null
    realtime?.stop.abort(new Error('The voice call ended.'))
    realtime = null
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
    if (result.ok) {
      realtimeCall = result.callId
      newRealtimeSession()
    }
    return result
  })
  const toolInput = z
    .object({
      name: z.enum(REALTIME_TOOLS.map((tool) => tool.name) as [string, ...string[]]),
      arguments: z.string().max(20_000),
      heard: z.array(z.string().max(4000)).max(50),
    })
    .strict()
  reg.mhandle('assistant:realtime-tool', async (event, input: unknown): Promise<string> => {
    if (!isAssistantSender(deps, event)) throw new Error('Only the assistant window calls the voice tools')
    const call = toolInput.parse(input)
    const session = realtime ?? newRealtimeSession()
    let args: unknown = {}
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      return JSON.stringify({ error: 'The arguments are not valid JSON.' })
    }
    session.heard = call.heard
    try {
      return await session.bridge.call(call.name, args, session.stop.signal)
    } catch (error) {
      if (session.stop.signal.aborted) return JSON.stringify({ error: 'The voice call ended.' })
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
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
  reg.mon('assistant:wake-burst', (event, pcm: unknown) => {
    if (isAssistantSender(deps, event)) void deps.wake.burst(pcm)
  })
  reg.mon('assistant:wake-mic-failed', (event) => {
    if (isAssistantSender(deps, event)) deps.wake.micFailed()
  })
  reg.mhandle('assistant:wake-state', (event) =>
    isAssistantSender(deps, event) ? deps.wake.state() : { listening: false }
  )
  reg.mhandle('assistant:wake-status', () => deps.wake.status())
}
