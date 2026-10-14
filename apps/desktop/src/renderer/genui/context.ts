import { createContext, useContext } from 'react'

/** What a generated interface may do in the message that holds it. */
export interface GenUiHost {
  /** The message is still streaming: its interfaces stay read-only until it finishes. */
  live: boolean
  /** Sends text as the user's next message; absent where the person cannot write (read-only views, notes). */
  send?: (text: string) => void
  /** Identifies the message, so what the person changes in its interfaces is restored when it shows again. */
  stateKey?: string
}

export const GenUiContext = createContext<GenUiHost>({ live: false })

export const useGenUiHost = (): GenUiHost => useContext(GenUiContext)
