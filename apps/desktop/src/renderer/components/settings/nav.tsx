import type { ReactNode } from 'react'
import {
  BarChart3,
  Bot,
  Cloud,
  Download,
  MessagesSquare,
  Palette,
  PanelRight,
  ShieldCheck,
  Workflow,
} from 'lucide-react'

export type SettingsSection =
  | 'chat'
  | 'platform'
  | 'bots'
  | 'usage'
  | 'appearance'
  | 'tools'
  | 'execution'
  | 'privacy'
  | 'updates'

export const SETTINGS_NAV: { id: SettingsSection; icon: ReactNode; labelKey: string }[] = [
  { id: 'chat', icon: <MessagesSquare className="size-4" />, labelKey: 'settings.nav.chat' },
  { id: 'bots', icon: <Bot className="size-4" />, labelKey: 'settings.nav.bots' },
  { id: 'platform', icon: <Cloud className="size-4" />, labelKey: 'settings.nav.platform' },
  { id: 'usage', icon: <BarChart3 className="size-4" />, labelKey: 'settings.nav.usage' },
  { id: 'appearance', icon: <Palette className="size-4" />, labelKey: 'settings.nav.appearance' },
  { id: 'tools', icon: <PanelRight className="size-4" />, labelKey: 'settings.nav.tools' },
  { id: 'execution', icon: <Workflow className="size-4" />, labelKey: 'settings.nav.execution' },
  { id: 'privacy', icon: <ShieldCheck className="size-4" />, labelKey: 'settings.nav.privacy' },
  { id: 'updates', icon: <Download className="size-4" />, labelKey: 'settings.nav.updates' },
]
