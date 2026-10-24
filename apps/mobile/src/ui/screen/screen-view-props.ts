import type { Ref } from 'react'
import type { ScreenPageCommand, ScreenPageMessage } from '../../screen/screen-page'

/** What the screen's view takes commands through; it holds them until its page is ready. */
export type ScreenViewHandle = { send(command: ScreenPageCommand): void }

export type ScreenViewProps = {
  ref?: Ref<ScreenViewHandle>
  /** What a screen reader calls the screen. */
  label: string
  onMessage: (message: ScreenPageMessage) => void
}
