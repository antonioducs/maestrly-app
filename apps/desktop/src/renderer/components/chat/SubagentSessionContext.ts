import { createContext, useContext } from 'react'
import type { SubagentSessionSummary } from '../../../shared/chat'

export interface OpenSubagentSessionInput {
  conversationId: string
  parentMessageId: string
  toolCallId: string
}

export type OpenSubagentSession = (input: OpenSubagentSessionInput) => Promise<boolean>

export const SubagentSessionContext = createContext<OpenSubagentSession | null>(null)
export const SubagentSessionsContext = createContext<readonly SubagentSessionSummary[]>([])

export function useOpenSubagentSession(): OpenSubagentSession | null {
  return useContext(SubagentSessionContext)
}

export function useSubagentSessions(): readonly SubagentSessionSummary[] {
  return useContext(SubagentSessionsContext)
}
