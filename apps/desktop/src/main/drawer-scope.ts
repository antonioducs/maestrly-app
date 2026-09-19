import { isFloatTab, type FloatTab } from '../shared/tool-tabs'
import { getConversation } from './store'

/** Main-process admission for renderer requests and restored native views. */
export function conversationTabAllowed(convId: string, tab: FloatTab): boolean {
  return isFloatTab(tab) && !(tab === 'review' && getConversation(convId)?.scope === 'standalone')
}
