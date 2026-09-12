import type {
  LocalConversationBlocker,
  LocalConversationPreview,
  LocalConversationRecovery,
} from '../../../shared/local-conversation'

export type LocalConversationFlowState =
  | { step: 'form' }
  | { step: 'preparing' }
  | { step: 'preview'; token: string; preview: LocalConversationPreview; message?: string }
  | { step: 'confirming'; token: string; preview: LocalConversationPreview }
  | { step: 'blocked'; preview: LocalConversationPreview; blockers: LocalConversationBlocker[] }
  | { step: 'recovery'; preview: LocalConversationPreview; recovery: LocalConversationRecovery }
  | { step: 'created'; warning?: string; stashOid?: string }

export type LocalConversationFlowAction =
  | { type: 'reset' }
  | { type: 'prepare' }
  | { type: 'preview'; token: string; preview: LocalConversationPreview; message?: string }
  | { type: 'confirm' }
  | { type: 'blocked'; preview: LocalConversationPreview; blockers: LocalConversationBlocker[] }
  | { type: 'recovery'; preview: LocalConversationPreview; recovery: LocalConversationRecovery }
  | { type: 'created'; warning?: string; stashOid?: string }

export const initialLocalConversationFlow: LocalConversationFlowState = { step: 'form' }

export function localConversationFlowReducer(
  state: LocalConversationFlowState,
  action: LocalConversationFlowAction
): LocalConversationFlowState {
  switch (action.type) {
    case 'reset':
      return initialLocalConversationFlow
    case 'prepare':
      return { step: 'preparing' }
    case 'preview':
      return {
        step: 'preview',
        token: action.token,
        preview: action.preview,
        message: action.message,
      }
    case 'confirm':
      return state.step === 'preview' ? { step: 'confirming', token: state.token, preview: state.preview } : state
    case 'blocked':
      return { step: 'blocked', preview: action.preview, blockers: action.blockers }
    case 'recovery':
      return { step: 'recovery', preview: action.preview, recovery: action.recovery }
    case 'created':
      return { step: 'created', warning: action.warning, stashOid: action.stashOid }
  }
}
