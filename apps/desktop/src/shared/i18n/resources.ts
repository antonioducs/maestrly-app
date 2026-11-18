import enUi from './en/ui'
import enMcp from './en/mcp'
import enPrompts from './en/prompts'
import enMain from './en/main'
import enChat from './en/chat'
import enFleet from './en/fleet'
import enPlugins from './en/plugins'
import enRoutines from './en/routines'
import ptUi from './pt-BR/ui'
import ptMcp from './pt-BR/mcp'
import ptPrompts from './pt-BR/prompts'
import ptMain from './pt-BR/main'
import ptChat from './pt-BR/chat'
import ptFleet from './pt-BR/fleet'
import ptPlugins from './pt-BR/plugins'
import ptRoutines from './pt-BR/routines'

export const namespaces = ['ui', 'mcp', 'prompts', 'main', 'chat', 'fleet', 'plugins', 'routines'] as const

export const defaultNS = 'ui'

export const resources = {
  en: {
    ui: enUi,
    mcp: enMcp,
    prompts: enPrompts,
    main: enMain,
    chat: enChat,
    fleet: enFleet,
    plugins: enPlugins,
    routines: enRoutines,
  },
  'pt-BR': {
    ui: ptUi,
    mcp: ptMcp,
    prompts: ptPrompts,
    main: ptMain,
    chat: ptChat,
    fleet: ptFleet,
    plugins: ptPlugins,
    routines: ptRoutines,
  },
}
