import { createContext, useContext, type MutableRefObject } from 'react'
import { cn } from '@/lib/utils'
import type { ShortcutBinding, ShortcutOs } from '../../../shared/shortcuts'

/** How a recording ends: its text joins the draft, is sent with the draft, or is thrown away. */
export type DictationFinish = 'insert' | 'send' | 'discard'

/** Toggles dictation while the editor has focus: ⌘D on macOS, Ctrl+D on Windows and Linux. */
export function dictationShortcut(os: ShortcutOs): ShortcutBinding {
  return { key: 'd', mods: [os === 'mac' ? 'meta' : 'control'] }
}

/** Registered by the microphone so the editor's keys reach it. */
export interface DictationControl {
  /** Recording or transcribing. */
  active: boolean
  /** Starts a recording, or ends the current one into the draft. */
  toggle: () => void
  finish: (how: DictationFinish) => void
}

/**
 * Links ChatComposer to the microphone in its slot. While the microphone records or transcribes it takes over the
 * composer's action bar, so no other send or stop button is there to be clicked by mistake, and the editor's Enter
 * and Esc finish the recording instead of sending the draft or stopping the agent.
 */
export interface ComposerDictation {
  /** The agent is working. */
  streaming: boolean
  /** A send now waits in the queue until the agent finishes. */
  queues: boolean
  control: MutableRefObject<DictationControl | null>
  onActiveChange: (active: boolean) => void
  focusEditor: () => void
}

export const ComposerDictationContext = createContext<ComposerDictation | null>(null)

export function useComposerDictation(): ComposerDictation | null {
  return useContext(ComposerDictationContext)
}

/** Turns around the composer's main button while the agent works. */
export function WorkingRing({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <span
      aria-hidden
      className={cn(
        'chat-working-ring pointer-events-none absolute -inset-[3px] rounded-full border-2 border-indigo-400/20',
        'border-t-indigo-400 animate-spin motion-reduce:animate-none motion-reduce:border-indigo-400/60'
      )}
    />
  )
}
