import { Bell, BellOff, CheckCircle2, Languages, Volume2, VolumeX } from 'lucide-react'
import { LOCALES, LOCALE_LABELS, type SupportedLocale } from '../../../shared/locale'
import {
  SOUND_EVENTS,
  SOUND_VOICES,
  SOUND_VOICE_LABELS,
  type SoundEvent,
  type SoundSettings,
  type SoundVoice,
} from '../../../shared/sound'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { TFn } from './shared'

export function LanguageSection({
  t,
  locale,
  setLocale,
}: {
  t: TFn
  locale: SupportedLocale
  setLocale: (next: SupportedLocale) => void
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Languages className="size-4 text-muted-foreground" /> {t('settings.language.heading')}
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.language.desc')}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {LOCALES.map((loc) => (
          <button
            key={loc}
            type="button"
            onClick={() => setLocale(loc)}
            aria-pressed={locale === loc}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition-colors',
              locale === loc
                ? 'border-primary/50 bg-primary/15 text-foreground'
                : 'border-border bg-white/[0.02] text-muted-foreground hover:text-foreground'
            )}
          >
            {locale === loc && <CheckCircle2 className="size-3.5" />}
            {LOCALE_LABELS[loc]}
          </button>
        ))}
      </div>
    </section>
  )
}

export function SoundSection({
  t,
  sound,
  toggleSoundMute,
  setMasterVolume,
  setEventVoice,
  toggleEventMute,
  setEventVolume,
  previewEventVolume,
}: {
  t: TFn
  sound: SoundSettings
  toggleSoundMute: () => void
  setMasterVolume: (v: number) => void
  setEventVoice: (event: SoundEvent, voice: SoundVoice) => void
  toggleEventMute: (event: SoundEvent) => void
  setEventVolume: (event: SoundEvent, v: number) => void
  previewEventVolume: (event: SoundEvent, v: number) => void
}) {
  const soundEventLabel: Record<SoundEvent, string> = {
    ready: t('settings.sound.events.ready'),
    error: t('settings.sound.events.error'),
    permission: t('settings.sound.events.permission'),
    plan: t('settings.sound.events.plan'),
  }

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          {sound.muted ? (
            <BellOff className="size-4 text-muted-foreground" />
          ) : (
            <Bell className="size-4 text-muted-foreground" />
          )}
          {t('settings.sound.heading')}
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.sound.desc')}</p>
      </div>

      <button
        type="button"
        onClick={toggleSoundMute}
        className="flex items-start gap-2.5 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
      >
        {sound.muted ? (
          <BellOff className="mt-0.5 size-4 shrink-0 text-amber-400" />
        ) : (
          <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{t('settings.sound.muteTitle')}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{t('settings.sound.muteDesc')}</div>
        </div>
        <span
          className={cn(
            'mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
            sound.muted ? 'bg-primary' : 'bg-white/15'
          )}
        >
          <span className={cn('size-4 rounded-full bg-white transition-transform', sound.muted && 'translate-x-4')} />
        </span>
      </button>

      <div
        className={cn(
          'flex items-center gap-3 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5',
          sound.muted && 'pointer-events-none opacity-50'
        )}
      >
        <Volume2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 text-sm font-medium text-foreground">{t('settings.sound.volume')}</div>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(sound.volume * 100)}
          onChange={(e) => setMasterVolume(Number(e.target.value) / 100)}
          disabled={sound.muted}
          aria-label={t('settings.sound.volume')}
          className="h-1.5 w-28 cursor-pointer accent-primary disabled:cursor-default"
        />
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
          {Math.round(sound.volume * 100)}%
        </span>
      </div>

      <div
        className={cn(
          'flex flex-col divide-y divide-border rounded-lg border border-border bg-white/[0.02] px-3',
          sound.muted && 'pointer-events-none opacity-50'
        )}
      >
        {SOUND_EVENTS.map((ev) => {
          const eventMuted = sound.mutedEvents[ev]
          const pct = Math.round(sound.volumes[ev] * 100)
          return (
            <div key={ev} className="flex items-center gap-2.5 py-2.5">
              <button
                type="button"
                onClick={() => toggleEventMute(ev)}
                disabled={sound.muted}
                title={eventMuted ? t('settings.sound.unmute') : t('settings.sound.mute')}
                aria-label={eventMuted ? t('settings.sound.unmute') : t('settings.sound.mute')}
                aria-pressed={eventMuted}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {eventMuted ? <VolumeX className="size-4 text-amber-400" /> : <Volume2 className="size-4" />}
              </button>
              <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{soundEventLabel[ev]}</div>
              <Select
                value={sound.events[ev]}
                onValueChange={(v) => setEventVoice(ev, v as SoundVoice)}
                disabled={sound.muted}
              >
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOUND_VOICES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {SOUND_VOICE_LABELS[v]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={pct}
                onChange={(e) => setEventVolume(ev, Number(e.target.value) / 100)}
                onPointerUp={(e) => previewEventVolume(ev, Number(e.currentTarget.value) / 100)}
                onKeyUp={(e) => previewEventVolume(ev, Number(e.currentTarget.value) / 100)}
                disabled={sound.muted || eventMuted}
                aria-label={`${soundEventLabel[ev]} — ${t('settings.sound.volume')}`}
                className="h-1.5 w-20 cursor-pointer accent-primary disabled:cursor-default disabled:opacity-50"
              />
              <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {eventMuted ? '—' : `${pct}%`}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
