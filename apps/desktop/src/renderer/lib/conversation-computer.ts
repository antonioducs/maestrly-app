import type { ComputerOpenResult } from '../../shared/conversation-computer'

/** What a remote conversation's Computer tab shows while it opens the computer, and after. */
export type ComputerTabStage = 'opening' | 'screen' | 'busy' | 'unavailable' | 'error'

/** The stage that answering `drawer:computer-open` with `result` (or failing with it) leads to. */
export function computerStage(result: ComputerOpenResult | Error): {
  stage: ComputerTabStage
  holders: string[]
  error: string
} {
  if (result instanceof Error) return { stage: 'error', holders: [], error: result.message }
  if (result.ok) return { stage: 'screen', holders: [], error: '' }
  if (result.reason === 'busy') return { stage: 'busy', holders: [...result.holders], error: '' }
  return { stage: 'unavailable', holders: [], error: '' }
}
