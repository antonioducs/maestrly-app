import enUi from './en/ui'
import enMcp from './en/mcp'
import enPrompts from './en/prompts'
import enMain from './en/main'
import enChat from './en/chat'
import enFleet from './en/fleet'
import ptUi from './pt-BR/ui'
import ptMcp from './pt-BR/mcp'
import ptPrompts from './pt-BR/prompts'
import ptMain from './pt-BR/main'
import ptChat from './pt-BR/chat'
import ptFleet from './pt-BR/fleet'

export const namespaces = ['ui', 'mcp', 'prompts', 'main', 'chat', 'fleet'] as const

export const defaultNS = 'ui'

export const resources = {
  en: { ui: enUi, mcp: enMcp, prompts: enPrompts, main: enMain, chat: enChat, fleet: enFleet },
  'pt-BR': { ui: ptUi, mcp: ptMcp, prompts: ptPrompts, main: ptMain, chat: ptChat, fleet: ptFleet },
}
