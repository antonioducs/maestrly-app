import { z } from 'zod'
import type { ShortcutBinding, ShortcutOs } from './shortcuts'

/** The conversation that plays the assistant role. Written only by the main process. */
export const ASSISTANT_CONVERSATION_SETTING = 'assistant.conversationId'
/** The person's assistant preferences, as one JSON value. */
export const ASSISTANT_SETTINGS_KEY = 'assistant.settings'
/** Last bounds of the assistant window. */
export const ASSISTANT_WINDOW_BOUNDS_KEY = 'assistant.windowBounds'
/** Command-line flag that shows or hides the assistant (for system shortcuts where global shortcuts do not work). */
export const ASSISTANT_TOGGLE_FLAG = '--toggle-assistant'

export const assistantShortcutSchema = z
  .object({
    key: z.string().trim().min(1).max(20),
    mods: z
      .array(z.enum(['meta', 'control', 'alt', 'shift']))
      .min(1)
      .max(4),
  })
  .strict()

export const ASSISTANT_OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const
export type AssistantOpenAiVoice = (typeof ASSISTANT_OPENAI_VOICES)[number]

export const assistantVoiceSchema = z
  .object({
    /** `agent`: the assistant conversation answers, read aloud; `realtime`: an OpenAI Realtime session talks. */
    mode: z.enum(['agent', 'realtime']).default('agent'),
    /** Who reads the answers in agent mode: the system's voices, or OpenAI's with the person's key. */
    engine: z.enum(['system', 'openai']).default('system'),
    /** The system voice's name; null for the system default. */
    systemVoice: z.string().max(200).nullable().default(null),
    openaiVoice: z.enum(ASSISTANT_OPENAI_VOICES).default('marin'),
    speed: z.number().min(0.5).max(2).default(1),
    /** Read an answer aloud when the message was spoken. */
    autoSpeak: z.boolean().default(true),
    /** The global shortcut opens the window listening. */
    shortcutListens: z.boolean().default(true),
    realtimeModel: z.enum(['gpt-realtime', 'gpt-realtime-mini']).default('gpt-realtime-mini'),
    realtimeVoice: z.enum(ASSISTANT_OPENAI_VOICES).default('marin'),
  })
  .strict()
export type AssistantVoiceSettings = z.infer<typeof assistantVoiceSchema>

export const assistantSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Absent means the default for the OS; null turns the global shortcut off. */
    shortcut: assistantShortcutSchema.nullable().optional(),
    hideOnBlur: z.boolean().default(true),
    keepRunning: z.boolean().default(true),
    voice: assistantVoiceSchema.default(() => assistantVoiceSchema.parse({})),
  })
  .strict()

export type AssistantSettings = z.infer<typeof assistantSettingsSchema>
/** A change to the settings; `voice` changes only the fields it names. */
export type AssistantSettingsPatch = Partial<Omit<z.input<typeof assistantSettingsSchema>, 'voice'>> & {
  voice?: Partial<AssistantVoiceSettings>
}

/** Valid fields of a stored or patched voice object, each falling back on its own. */
function voiceFields(raw: unknown): Partial<AssistantVoiceSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const shape = assistantVoiceSchema.shape
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const field = shape[key as keyof typeof shape]
    if (!field) continue
    const one = field.safeParse(value)
    if (one.success) out[key] = one.data
  }
  return out as Partial<AssistantVoiceSettings>
}

/** The settings after `patch`; an invalid patch throws and changes nothing. `voice` merges field by field. */
export function mergeAssistantSettings(current: AssistantSettings, patch: unknown): AssistantSettings {
  const value = (patch ?? {}) as AssistantSettingsPatch
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid assistant settings')
  const voice = value.voice === undefined ? current.voice : { ...current.voice, ...value.voice }
  return assistantSettingsSchema.parse({ ...current, ...value, voice })
}

/** ⌘⇧Space on macOS, Ctrl+Shift+Space elsewhere. */
export function defaultAssistantShortcut(os: ShortcutOs): ShortcutBinding {
  return { key: 'space', mods: [os === 'mac' ? 'meta' : 'control', 'shift'] }
}

/** The binding in effect: the person's, the OS default when they never chose one, or null when turned off. */
export function effectiveAssistantShortcut(settings: AssistantSettings, os: ShortcutOs): ShortcutBinding | null {
  if (settings.shortcut === undefined) return defaultAssistantShortcut(os)
  return settings.shortcut
}

export interface RecordedKey {
  code: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * The binding a key press records in the shortcut field: null while only modifiers are held, and 'invalid' for a key
 * a global shortcut cannot use or a press without a modifier other than Shift.
 */
export function bindingFromKeyPress(event: RecordedKey): ShortcutBinding | null | 'invalid' {
  if (
    /^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/.test(event.code) ||
    ['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)
  )
    return null
  let key: string | null = null
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code.toLowerCase()
  else if (event.code === 'Space') key = 'space'
  else if (event.code === 'Enter') key = 'enter'
  else if (event.code === 'Tab') key = 'tab'
  else if (/^Arrow(Up|Down|Left|Right)$/.test(event.code)) key = event.code.toLowerCase()
  const mods: ShortcutBinding['mods'] = []
  if (event.metaKey) mods.push('meta')
  if (event.ctrlKey) mods.push('control')
  if (event.altKey) mods.push('alt')
  if (event.shiftKey) mods.push('shift')
  if (!key || !mods.some((mod) => mod !== 'shift')) return 'invalid'
  return { key, mods }
}

/** Stored settings, falling back to defaults field by field when the stored value is missing or invalid. */
export function parseAssistantSettings(raw: unknown): AssistantSettings {
  const parsed = assistantSettingsSchema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  const out = assistantSettingsSchema.parse({})
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'voice') {
        out.voice = { ...out.voice, ...voiceFields(value) }
        continue
      }
      const one = assistantSettingsSchema.safeParse({ [key]: value })
      if (one.success && key in one.data) Object.assign(out, { [key]: (one.data as Record<string, unknown>)[key] })
    }
  }
  return out
}

export interface AssistantInfo {
  conversationId: string
  cwd: string
}

export interface AssistantSettingsState {
  settings: AssistantSettings
  /** Why the global shortcut is not registered, when it is not. */
  shortcutError: 'conflict' | 'unsupported' | null
  /** Global shortcuts are unreliable on Wayland: the person binds a system shortcut to the toggle flag instead. */
  wayland: boolean
}

export type AssistantHoldReason = 'question' | 'listening' | 'speaking'

/** The voices Settings offers for the OpenAI engine, and whether a key to use them is set. */
export interface AssistantVoiceOptions {
  openai: AssistantOpenAiVoice[]
  openaiKey: boolean
}

export type AssistantTtsError = 'key-missing' | 'key-rejected' | 'too-long' | 'network' | 'cancelled'
export type AssistantTtsResult =
  | { ok: true; audio: ArrayBuffer; mime: 'audio/mpeg' }
  | { ok: false; error: AssistantTtsError }
