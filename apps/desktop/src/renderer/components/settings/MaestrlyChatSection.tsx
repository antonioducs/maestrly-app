import { ApiKeySettings } from '@/components/chat/ApiKeySettings'
import type { ChatSettingsOptions } from '@/components/chat/chat-settings-tabs'
import type { TFn } from './shared'

export function MaestrlyChatSection({ t, chat }: { t: TFn; chat?: ChatSettingsOptions }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Maestrly Chat</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.maestrlyChat.desc')}</p>
      </div>
      <ApiKeySettings {...chat} />
    </section>
  )
}
