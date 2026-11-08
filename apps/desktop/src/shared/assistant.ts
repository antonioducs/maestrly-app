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

export const assistantSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Absent means the default for the OS; null turns the global shortcut off. */
    shortcut: assistantShortcutSchema.nullable().optional(),
    hideOnBlur: z.boolean().default(true),
    keepRunning: z.boolean().default(true),
  })
  .strict()

export type AssistantSettings = z.infer<typeof assistantSettingsSchema>
export type AssistantSettingsPatch = Partial<z.input<typeof assistantSettingsSchema>>

/** ⌘⇧Space on macOS, Ctrl+Shift+Space elsewhere. */
export function defaultAssistantShortcut(os: ShortcutOs): ShortcutBinding {
  return { key: 'space', mods: [os === 'mac' ? 'meta' : 'control', 'shift'] }
}

/** The binding in effect: the person's, the OS default when they never chose one, or null when turned off. */
export function effectiveAssistantShortcut(settings: AssistantSettings, os: ShortcutOs): ShortcutBinding | null {
  if (settings.shortcut === undefined) return defaultAssistantShortcut(os)
  return settings.shortcut
}

/** Stored settings, falling back to defaults field by field when the stored value is missing or invalid. */
export function parseAssistantSettings(raw: unknown): AssistantSettings {
  const parsed = assistantSettingsSchema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  const out = assistantSettingsSchema.parse({})
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
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
