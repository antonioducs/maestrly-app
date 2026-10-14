import { createContext, useContext } from 'react'

/** What a generated interface may do in the message that holds it. */
export interface GenUiHost {
  /** The message is still streaming: an interface renders once its own block is complete. */
  live: boolean
  /** Sends text as the user's next message; absent where the person cannot write (read-only views, notes). */
  send?: (text: string) => void
  /** The HTML of the previews the message rendered, by id: its answer shows them by naming them. */
  previews?: ReadonlyMap<string, string>
}

export const GenUiContext = createContext<GenUiHost>({ live: false })

export const useGenUiHost = (): GenUiHost => useContext(GenUiContext)
