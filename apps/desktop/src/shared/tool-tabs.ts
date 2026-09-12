export const FLOAT_TABS = ['browser', 'vscode', 'terminal', 'plan', 'review', 'notes', 'chatgpt'] as const

export type FloatTab = (typeof FLOAT_TABS)[number]

export type DrawerTab = FloatTab

export function isFloatTab(v: unknown): v is FloatTab {
  return typeof v === 'string' && (FLOAT_TABS as readonly string[]).includes(v)
}
