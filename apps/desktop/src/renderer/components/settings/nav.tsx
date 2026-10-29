import type { ReactNode } from 'react'
import {
  AppWindow,
  BarChart3,
  Bot,
  Cpu,
  Download,
  Laptop,
  MessagesSquare,
  Palette,
  PanelRight,
  ShieldCheck,
  Workflow,
} from 'lucide-react'

export type SettingsSection =
  | 'chat'
  | 'fleet'
  | 'computers'
  | 'runner'
  | 'usage'
  | 'appearance'
  | 'tools'
  | 'artifacts'
  | 'execution'
  | 'privacy'
  | 'updates'

export const SETTINGS_NAV: { id: SettingsSection; icon: ReactNode; labelKey: string }[] = [
  { id: 'chat', icon: <MessagesSquare className="size-4" />, labelKey: 'settings.nav.chat' },
  { id: 'fleet', icon: <Bot className="size-4" />, labelKey: 'settings.nav.fleet' },
  { id: 'computers', icon: <Laptop className="size-4" />, labelKey: 'settings.nav.computers' },
  { id: 'runner', icon: <Cpu className="size-4" />, labelKey: 'settings.nav.runner' },
  { id: 'usage', icon: <BarChart3 className="size-4" />, labelKey: 'settings.nav.usage' },
  { id: 'appearance', icon: <Palette className="size-4" />, labelKey: 'settings.nav.appearance' },
  { id: 'tools', icon: <PanelRight className="size-4" />, labelKey: 'settings.nav.tools' },
  { id: 'artifacts', icon: <AppWindow className="size-4" />, labelKey: 'settings.nav.artifacts' },
  { id: 'execution', icon: <Workflow className="size-4" />, labelKey: 'settings.nav.execution' },
  { id: 'privacy', icon: <ShieldCheck className="size-4" />, labelKey: 'settings.nav.privacy' },
  { id: 'updates', icon: <Download className="size-4" />, labelKey: 'settings.nav.updates' },
]
