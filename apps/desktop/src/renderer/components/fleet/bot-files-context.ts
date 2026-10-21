import { createContext, useContext } from 'react'

const RemovedFiles = createContext<(fileId: string) => string | null>(() => null)

/** When a file the bot shared was deleted, for its cards in any of the bot's conversations; null while it exists. */
export const BotFilesRemovedProvider = RemovedFiles.Provider
export const useRemovedFile = (fileId: string): string | null => useContext(RemovedFiles)(fileId)
