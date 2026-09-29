// The viewer shell is served to browsers that do not run the Maestrly app, so it carries its own small catalogs.

export type ShellLocale = 'en' | 'pt-BR'

const en = {
  loading: 'Loading…',
  notAvailable: 'This page is not available',
  notAvailableDetail: 'The link may be wrong, or the page was removed or is no longer shared with you.',
  version: 'Version {n}',
  current: 'current',
  owner: 'You (owner)',
  leave: 'Leave',
  left: 'You left this page',
  leftDetail: 'This device no longer has access to the page.',
  pageError: 'The page reported an error: {message}',
  retry: 'Try again',
  versionsLabel: 'Version',
}

export type ShellKey = keyof typeof en

const ptBR: Record<ShellKey, string> = {
  loading: 'Carregando…',
  notAvailable: 'Esta página não está disponível',
  notAvailableDetail: 'O link pode estar errado, ou a página foi removida ou não está mais compartilhada com você.',
  version: 'Versão {n}',
  current: 'atual',
  owner: 'Você (dono)',
  leave: 'Sair',
  left: 'Você saiu desta página',
  leftDetail: 'Este dispositivo não tem mais acesso à página.',
  pageError: 'A página informou um erro: {message}',
  retry: 'Tentar de novo',
  versionsLabel: 'Versão',
}

export const SHELL_CATALOGS: Readonly<Record<ShellLocale, Readonly<Record<ShellKey, string>>>> = {
  en,
  'pt-BR': ptBR,
}

export function pickLocale(languages: readonly string[]): ShellLocale {
  return languages[0]?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'
}

export function format(locale: ShellLocale, key: ShellKey, vars: Record<string, string | number> = {}): string {
  return SHELL_CATALOGS[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}
