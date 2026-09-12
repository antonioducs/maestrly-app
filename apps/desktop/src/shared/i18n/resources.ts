import enUi from './en/ui'
import enMcp from './en/mcp'
import enPrompts from './en/prompts'
import enMain from './en/main'
import enChat from './en/chat'
import ptUi from './pt-BR/ui'
import ptMcp from './pt-BR/mcp'
import ptPrompts from './pt-BR/prompts'
import ptMain from './pt-BR/main'
import ptChat from './pt-BR/chat'

export const namespaces = ['ui', 'mcp', 'prompts', 'main', 'chat'] as const

export const defaultNS = 'ui'

export const resources = {
  en: { ui: enUi, mcp: enMcp, prompts: enPrompts, main: enMain, chat: enChat },
  'pt-BR': { ui: ptUi, mcp: ptMcp, prompts: ptPrompts, main: ptMain, chat: ptChat },
}
